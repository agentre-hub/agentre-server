import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

// 与 workspace_svc.AvailabilityXxx 的字符串常量一一对应（internal/service/workspace_svc/workspace.go）。
type Availability = "available" | "offline" | "unpaired" | "skipped_for_web";

interface ExecTargetItem {
  rank: number;
  is_local_reference: boolean;
  device_id?: number;
  device_name?: string;
  backend_type?: string;
  availability: Availability;
  current: boolean;
}

interface AgentItem {
  sync_id: string;
  name: string;
  avatar_color?: string;
  department_name?: string;
  exec_targets: ExecTargetItem[];
  has_available_target: boolean;
}

function loadErrorText(e: unknown, t: (key: string) => string): string {
  return e instanceof ApiError ? e.message : t("overview.loadError");
}

/** 每一档的说明文案：只在「不是当前生效」时才需要额外说一句为什么。 */
function reasonKey(target: ExecTargetItem): string | null {
  switch (target.availability) {
    case "skipped_for_web":
      return "overview.skippedForWeb";
    case "offline":
      return "overview.offline";
    case "unpaired":
      return "overview.unpaired";
    default:
      return null;
  }
}

function TargetChip({
  target,
  t,
}: {
  target: ExecTargetItem;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const reason = reasonKey(target);
  const label = target.is_local_reference
    ? t("overview.thisDevice")
    : (target.device_name ?? "");
  const suffix = target.backend_type ? ` · ${target.backend_type}` : "";
  return (
    <span
      data-current={target.current ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs",
        target.current
          ? "bg-primary-soft text-primary-text font-semibold"
          : "bg-muted text-muted-foreground",
      )}
    >
      <span className="font-mono text-[10px] font-bold">{target.rank}</span>
      <span>
        {label}
        {suffix}
      </span>
      {reason && (
        <span className="font-mono text-[10px] text-subtle-foreground">
          {t(reason)}
        </span>
      )}
    </span>
  );
}

function AgentRow({
  agent,
  t,
}: {
  agent: AgentItem;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const current = agent.exec_targets.find((tt) => tt.current);
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-primary"
          style={
            agent.avatar_color
              ? { backgroundColor: agent.avatar_color }
              : undefined
          }
        />
        <span className="text-sm font-bold text-foreground">{agent.name}</span>
        {agent.department_name && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
            {agent.department_name}
          </span>
        )}
        <span className="flex-1" />
        {agent.has_available_target && current ? (
          <span className="text-xs font-medium text-muted-foreground">
            {t("overview.currentTarget", {
              device: current.is_local_reference
                ? t("overview.thisDevice")
                : current.device_name,
            })}
          </span>
        ) : (
          <span className="text-xs font-medium text-destructive">
            {t("overview.noAvailableTarget")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-4">
        {agent.exec_targets.map((target, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && (
              <ArrowRight
                aria-hidden="true"
                className="size-3 shrink-0 text-muted-foreground"
              />
            )}
            <TargetChip target={target} t={t} />
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Overview() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    api<{ agents: AgentItem[] }>("/v1/workspace/agents")
      .then((got) => {
        if (alive) {
          setAgents(got.agents);
          setLoadError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e ?? new Error("agent list load failed"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <AppShell>
      <div className="w-full max-w-3xl space-y-6">
        <h1 className="text-2xl font-semibold text-foreground">
          {t("overview.title")}
        </h1>

        {loadError !== null && (
          <Alert variant="destructive">{loadErrorText(loadError, t)}</Alert>
        )}

        {loading ? (
          <p className="text-muted-foreground">{t("common.loading")}</p>
        ) : loadError !== null &&
          (agents?.length ?? 0) === 0 ? null : (agents?.length ?? 0) === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground">
              {t("overview.empty")}
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden py-0">
            <CardHeader className="flex flex-row items-center gap-2 border-b border-border px-4 py-3">
              <span className="text-sm font-bold text-foreground">
                {t("overview.title")}
              </span>
              <span className="text-xs text-subtle-foreground">
                {t("overview.subtitle", { count: agents?.length ?? 0 })}
              </span>
            </CardHeader>
            <CardContent className="p-0">
              {agents?.map((agent) => (
                <AgentRow key={agent.sync_id} agent={agent} t={t} />
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
