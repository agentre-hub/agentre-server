/**
 * R15 / R17 的新对话发起弹层（设计稿屏 23 / 24 / 25）。
 *
 * 三步：选 Agent（23）→ 选项目（24）→ 确认 + 说第一句（25）。
 *
 *   - R15：派发计划（/v1/workspace/dispatch-target）按序列出执行目标链每一档的
 *     原因（本机跳过 / 未配对 / 离线 / 项目路径缺失），只有第一档可用的 agentred
 *     才能继续；全部不可用时不静默失败，逐档把原因摆给用户（屏 24 的「现在选不了」）。
 *   - R17：发起前就在确认步说明 org / subagent / hook 在当前目标下是否可用——目标是
 *     桌面端时这三个内置工具的真身就在那台机器上、可用；是 agentred 时轮 A 的 R17
 *     原样成立、不可用。不是等工具调用失败了才报错。
 *   - R16：确认后经 lib/dispatch.dispatchNewConversation 派发并立刻关注自己这条，
 *     于是它不经「关注」就出现在「对话」页。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import {
  dispatchNewConversation,
  fetchDispatchPlan,
  pickFirstAvailable,
  type DispatchedSession,
  type DispatchPlan,
  type DispatchTier,
} from "@/lib/dispatch";
import { ensureWebDevice } from "@/lib/webDevice";

interface AgentItem {
  sync_id: string;
  name: string;
  avatar_color?: string;
  has_available_target: boolean;
  exec_targets: {
    rank: number;
    device_name?: string;
    availability: string;
    current: boolean;
    is_local_reference: boolean;
  }[];
}

interface ProjectItem {
  sync_id: string;
  name: string;
  configured: boolean;
}

type Step = "agent" | "project" | "confirm";

function loadErrorText(e: unknown, t: (k: string) => string): string {
  return e instanceof ApiError ? e.message : t("device.manage.loadError");
}

/** 每一档不可用的原因文案键；available 无原因标签。 */
function reasonKey(availability: string): string | null {
  switch (availability) {
    case "skipped_for_web":
      return "overview.skippedForWeb";
    case "offline":
      return "overview.offline";
    case "unpaired":
      return "overview.unpaired";
    case "project_path_missing":
      return "chat.projectPathMissing";
    default:
      return null;
  }
}

function TierReason({
  tier,
  t,
}: {
  tier: DispatchTier;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const reason = reasonKey(tier.availability);
  const label = tier.device_name ?? t("overview.thisDevice");
  return (
    <li
      className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
      data-current={tier.current ? "true" : undefined}
    >
      <span className="font-mono text-[10px] font-bold text-subtle-foreground">
        {tier.rank}
      </span>
      <span className="font-medium text-foreground">{label}</span>
      {tier.backend_type && (
        <span className="font-mono text-[10px] text-subtle-foreground">
          {tier.backend_type}
        </span>
      )}
      {reason && (
        <span className="ml-auto text-xs text-muted-foreground">
          {t(reason)}
        </span>
      )}
    </li>
  );
}

const PROMPT_KEYS = ["chat.prompt1", "chat.prompt2", "chat.prompt3"] as const;

export default function NewConversationDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: (result: DispatchedSession) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("agent");
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [agent, setAgent] = useState<AgentItem | null>(null);
  const [pickPlan, setPickPlan] = useState<DispatchPlan | null>(null);
  const [project, setProject] = useState<ProjectItem | null>(null);
  const [finalPlan, setFinalPlan] = useState<DispatchPlan | null>(null);
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const [dispatchError, setDispatchError] = useState<unknown>(null);

  // 每次打开重新拉 Agent 清单（异步回调里 setState，不触发 cascading render）。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api<{ agents: AgentItem[] }>("/v1/workspace/agents")
      .then((d) => {
        if (!alive) return;
        setAgents(d.agents);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 状态重置放在「关闭」这一侧：下一次打开天然从初值开始，不在 effect 里同步 setState。
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setStep("agent");
        setAgents([]);
        setLoaded(false);
        setLoadError(null);
        setAgent(null);
        setPickPlan(null);
        setProject(null);
        setFinalPlan(null);
        setMessage("");
        setStarting(false);
        setDispatchError(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const chooseAgent = useCallback(async (a: AgentItem) => {
    setAgent(a);
    setStep("project");
    setPickPlan(null);
    setLoadError(null);
    try {
      setPickPlan(await fetchDispatchPlan(a.sync_id));
    } catch (e: unknown) {
      setLoadError(e);
    }
  }, []);

  const chooseProject = useCallback(
    async (p: ProjectItem) => {
      if (!agent) return;
      setProject(p);
      setLoadError(null);
      try {
        setFinalPlan(await fetchDispatchPlan(agent.sync_id, p.sync_id));
        setStep("confirm");
      } catch (e: unknown) {
        setLoadError(e);
      }
    },
    [agent],
  );

  const start = useCallback(async () => {
    if (!finalPlan || !message.trim()) return;
    setStarting(true);
    setDispatchError(null);
    try {
      const dev = await ensureWebDevice();
      const out = await dispatchNewConversation({
        plan: finalPlan,
        message,
        sourceDevice: dev,
      });
      onStarted?.(out);
    } catch (e: unknown) {
      setDispatchError(e);
    } finally {
      setStarting(false);
    }
  }, [finalPlan, message, onStarted]);

  const confirmChoice = finalPlan?.chosen ?? null;
  const availableTier = pickPlan
    ? pickFirstAvailable(pickPlan.tiers)
    : undefined;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === "agent"
              ? t("chat.pickAgent")
              : step === "project"
                ? t("chat.pickProject")
                : t("chat.confirmTitle")}
          </DialogTitle>
          {step === "project" && agent && (
            <p className="mt-1 text-[12px] font-normal text-muted-foreground">
              {t("chat.pickProjectFor", { agent: agent.name })}
            </p>
          )}
        </DialogHeader>

        <DialogBody>
          {loadError ? (
            <Alert variant="destructive">{loadErrorText(loadError, t)}</Alert>
          ) : step === "agent" ? (
            <div className="space-y-3">
              <p className="text-sm leading-[1.5] text-muted-foreground">
                {t("chat.pickAgentHint")}
              </p>
              {!loaded ? (
                <p className="text-sm text-muted-foreground">
                  {t("common.loading")}
                </p>
              ) : (
                <ul
                  className="space-y-2"
                  role="listbox"
                  aria-label={t("chat.pickAgent")}
                >
                  {agents.map((a) => {
                    const current = a.exec_targets.find((tt) => tt.current);
                    const label = a.has_available_target
                      ? current?.is_local_reference
                        ? t("overview.thisDevice")
                        : (current?.device_name ?? "")
                      : t("overview.noAvailableTarget");
                    return (
                      <li key={a.sync_id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={agent?.sync_id === a.sync_id}
                          className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
                          onClick={() => void chooseAgent(a)}
                        >
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-primary"
                            style={
                              a.avatar_color
                                ? { backgroundColor: a.avatar_color }
                                : undefined
                            }
                          />
                          <span className="text-sm font-semibold text-foreground">
                            {a.name}
                          </span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {label}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : step === "project" ? (
            <div className="space-y-3">
              {availableTier ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t("chat.willRunOn", {
                      machine: availableTier.device_name,
                    })}
                  </p>
                  {pickPlan && pickPlan.projects.length > 0 ? (
                    <ul
                      className="space-y-2"
                      role="listbox"
                      aria-label={t("chat.selectProject")}
                    >
                      {pickPlan.projects.map((p) => (
                        <li key={p.sync_id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={project?.sync_id === p.sync_id}
                            className="flex w-full items-center rounded-md border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                            onClick={() => void chooseProject(p)}
                          >
                            {p.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("chat.noProjectsOnMachine")}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-destructive">
                    {t("chat.unavailableTitle")}
                  </p>
                  {/* R15：全部档不可用时不静默失败，逐档给出原因。 */}
                  <ul className="space-y-2">
                    {pickPlan?.tiers.map((tier) => (
                      <TierReason key={tier.rank} tier={tier} t={t} />
                    ))}
                  </ul>
                </>
              )}
              <p className="text-[11px] leading-[1.5] text-muted-foreground">
                {t("chat.projectConfiguredHint")}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {confirmChoice && agent && (
                <p className="text-sm text-muted-foreground">
                  {t("chat.confirmRunOn", {
                    machine: confirmChoice.device_name,
                    path: confirmChoice.cwd ?? "",
                  })}
                </p>
              )}
              {/* R17：发起前如实说明当前目标下 org / subagent / hook 是否可用——目标是
                  桌面端时这三个内置工具的真身就在那台机器上、可用；是 agentred 时
                  轮 A 的 R17 原样成立、不可用。不是等工具调用失败了才报错。 */}
              {confirmChoice && (
                <div
                  role="note"
                  data-target-kind={confirmChoice.kind ?? ""}
                  className="rounded-md border border-border bg-muted px-3 py-2.5"
                >
                  <p className="text-[13px] font-semibold text-foreground">
                    {confirmChoice.kind === "desktop"
                      ? t("chat.r17DesktopTitle")
                      : t("chat.r17Title")}
                  </p>
                  <p className="mt-1 text-[12px] leading-[1.5] text-muted-foreground">
                    {confirmChoice.kind === "desktop"
                      ? t("chat.r17DesktopBody")
                      : t("chat.r17Body")}
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <label
                  htmlFor="new-conversation-first-message"
                  className="block text-sm font-medium text-foreground"
                >
                  {t("chat.firstMessage", { agent: agent?.name ?? "" })}
                </label>
                <p className="text-[11px] text-muted-foreground">
                  {t("chat.firstMessageHint")}
                </p>
                <Input
                  id="new-conversation-first-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t("chat.messagePlaceholder")}
                />
                <div className="flex flex-wrap gap-2">
                  {PROMPT_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => setMessage(t(key))}
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
              {dispatchError ? (
                <Alert variant="destructive">
                  {t("chat.connectFailed", {
                    machine: confirmChoice?.device_name ?? "",
                  })}
                </Alert>
              ) : null}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {step !== "agent" && (
            <Button
              variant="ghost"
              onClick={() => setStep(step === "project" ? "agent" : "project")}
            >
              {t("chat.back")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            {t("chat.cancel")}
          </Button>
          {step === "confirm" && (
            <Button
              onClick={() => void start()}
              disabled={!message.trim() || starting}
            >
              {starting ? t("chat.starting") : t("chat.start")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
