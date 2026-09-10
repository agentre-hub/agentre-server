import { rpcMethods } from "@agentre-hub/agentre-wire";
import {
  AgentAvatar,
  MESSAGE_AVATAR_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  type AIChatInputHandle,
  type ModelTarget,
  type TranscriptMessage,
  Alert,
  AlertDescription,
  Button,
  SessionHeaderBand,
  StatusDot,
  cn,
  iconNode,
  normalizePermissionMode,
  type SessionHeaderMetaPart,
} from "@agentre-hub/agentre-ui";
import { ArrowLeft, ChevronDown, FolderTree, Monitor } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import SessionModelControl from "@/components/session/SessionModelControl";
import SessionReasoningEffortControl from "@/components/session/SessionReasoningEffortControl";
import Transcript from "@/components/session/Transcript";
import { pendingUserMessage } from "@/components/session/transcriptFrame";
import { useSessionComposerModule } from "@/components/session/useSessionComposerModule";
import { useAliveEffect } from "@/hooks/use-api-query";
import { useRelayMachine } from "@/hooks/use-relay";
import { machineTarget } from "@/lib/relayTarget";
import { ApiError } from "@/lib/api";
import {
  decodePermissionModeMeta,
  decodeReasoningEffortSupport,
  type PermissionModeMeta,
} from "@/lib/backendCapabilities";
import { useEngineCatalog } from "@/lib/engineCatalog";
import {
  DispatchRunError,
  deriveTitle,
  dispatchNewConversation,
  fetchDispatchPlan,
  type DispatchPlan,
  type DispatchTier,
  type DispatchedSession,
} from "@/lib/dispatch";
import { rememberAgent } from "@/lib/recentAgents";
import { toAgentStatus } from "@/lib/sessionView";
import { ensureRelayTicket } from "@/lib/relayTicket";

import {
  availabilityReasonKey,
  type NewConvAgent,
  type NewConvProject,
} from "./types";

/**
 * 一条还没发第一句的对话。
 *
 * 形态与真会话详情同一套骨架（头 / 空转录 / 输入框），因为它**就是**一条对话，
 * 只是还没说话——旧弹层把「第一句」做成一次性的单行输入，发完还要跳一次页，
 * 用户打字的地方和之后一直用的地方是两个东西。
 *
 * 「将在 X 上运行」照搬桌面端空会话态那一行（chatPanel.execTarget）：一行小字
 * 加一枚可点的 chip，落在标题下面，不占顶栏。
 *
 * 派发前不落任何东西：没有草稿会话、左栏也不多一行——它还不是一条会话。
 */
export function DraftSession({
  agent,
  agents,
  projects,
  initialProjectSyncId,
  onStarted,
  onBack,
  headerRight,
}: {
  agent: NewConvAgent;
  /** 账号里全部 Agent，供输入框的 @ 菜单用（第一句同样能提及别人）。 */
  agents: NewConvAgent[];
  /** 账号项目树，只用来把 sync_id 翻成名字（派发计划里的项目只有名字，没有颜色）。 */
  projects: NewConvProject[];
  /**
   * 开这条草稿时就已经定下的项目（项目组头上那颗 ＋ 走的正是这一条）。默认不指定
   * ——从顶栏进来的是一条不钉项目的自由会话。仍然改得动：它是初值，不是锁。
   */
  initialProjectSyncId?: string;
  onStarted: (result: DispatchedSession) => void;
  /** 移动端的返回；桌面右栏里不给（左栏一直都在，没有「返回」这一说）。 */
  onBack?: () => void;
  /**
   * 宿主页面级的那簇控件（Chat 桌面档的连接态 + 语言/主题）。
   *
   * 与会话详情的 `headerRight` 同一件事：草稿这条带就是右栏的顶带，宿主不再另画
   * 一条 chat-chrome，那簇控件因此落在这一行的最右端。
   */
  headerRight?: ReactNode;
}) {
  const { t } = useTranslation();
  const composerModule = useSessionComposerModule();
  const composerRef = useRef<AIChatInputHandle>(null);
  const [projectSyncId, setProjectSyncId] = useState<string | null>(
    initialProjectSyncId ?? null,
  );
  const [targetBackendSyncId, setTargetBackendSyncId] = useState<string | null>(
    null,
  );
  /**
   * 派发在飞时**用户刚说的那句话**。存的是文本而不是一个布尔：这一小段屏幕上要
   * 摆的正是它（见下面的 `DraftPending`），而输入框在提交那一刻就已经被
   * AIChatInput 清空了，不留在这里就真的没了。
   */
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<unknown>(null);

  /**
   * 这份计划是**给哪一组入参算的**。三个入参任意一个变了都要重算：换项目会让某些
   * 机器变成「没配这个项目的路径」，换档会换掉指纹与 cwd。
   *
   * 算好的东西连同它的入参一起存：渲染时对不上就是「还在算」，不必在 effect 里先
   * 清一次 state。这样既不用在 effect 体里 setState，也顺带堵住一种真实的错序——
   * 上一组入参的响应晚于新的一组回来时，它带的 key 已经不是当前这组，覆盖不上。
   */
  /** 手动重试的轮次。并进 planKey：按一次就对不上，界面当场回到「还在算」。 */
  const [planAttempt, setPlanAttempt] = useState(0);
  const planKey = `${agent.sync_id}|${projectSyncId ?? ""}|${targetBackendSyncId ?? ""}|${planAttempt}`;
  const [planState, setPlanState] = useState<{
    key: string;
    plan?: DispatchPlan;
    error?: unknown;
  }>({ key: "" });

  useAliveEffect(
    (alive) => {
      void (async () => {
        try {
          const next = await fetchDispatchPlan({
            agentSyncId: agent.sync_id,
            projectSyncId: projectSyncId ?? undefined,
            targetBackendSyncId: targetBackendSyncId ?? undefined,
          });
          if (alive()) setPlanState({ key: planKey, plan: next });
        } catch (e: unknown) {
          if (alive()) setPlanState({ key: planKey, error: e });
        }
      })();
    },
    [agent.sync_id, planKey, projectSyncId, targetBackendSyncId],
  );

  const settled = planState.key === planKey;
  /**
   * 屏幕上摆的那一份：重算期间**留着上一份**，只把这一带标成 busy。
   *
   * 此前这里是 `settled ? plan : null`，而这一屏底下每一样都挂在它上面 —— 执行目标
   * 那一行、项目 chip、模型 / 档位 / 力度三颗控件一起卸掉，`useRelayMachine` 的目标
   * 也跟着变 null，连着的那台机器白断一次再连回来。换项目根本不换机器，一次往返里
   * 整个右栏拆了重搭。
   *
   * 上一份仍然是**这个 Agent 在这台机器上**的答案，只是还没算进刚改的那一维；
   * 新的一份一到就整份换掉。
   */
  const plan = planState.plan ?? null;
  const planError = settled ? (planState.error ?? null) : null;

  const chosen = plan?.chosen ?? null;
  /**
   * 敢拿去派发的那一份：只有**这一组入参**算出来的才算数。
   *
   * 与上面那一份分开，正是因为上面那份重算期间是旧的：拿它去派发就是按旧项目、
   * 旧机器开一条对话，而用户刚刚亲手改掉了那一维。
   */
  const readyPlan = settled ? plan : null;
  const { backends, catalog } = useEngineCatalog();

  /**
   * 开局就连上选中那台机器。
   *
   * 权限档位只能问执行端本人——服务端不掌握任何后端的档位集合，本站也不按
   * backendType 猜（那正是详情页上一轮改掉的东西）。顺带把「这台机器其实连不上」
   * 提前到用户打字之前暴露，而不是等他写完一整句再说。
   *
   * 这条连接随后**就是**派发用的那一条：再开一条等于同一台机器上两条会话连接。
   */
  // 按**机器**寻址（决策 11）：这条对话还不存在，服务端解析不出承载它的机器，
  // 而机器正是用户刚在派发计划里选定的那一台。
  const { client, relayState } = useRelayMachine(
    chosen ? machineTarget(chosen.device_fingerprint) : null,
  );

  /**
   * 执行端报的档位元数据。三态与详情页逐字同义：undefined = 还没问到（控件不摆）、
   * null = 问不出（控件不摆，但写一句「这台机器此刻列不出档位」说明为什么空着）、
   * allowedModes 为空 = 这个后端没有权限门（控件不摆，也不说话）。
   */
  const [permissionModeMeta, setPermissionModeMeta] = useState<
    PermissionModeMeta | null | undefined
  >(undefined);
  /** 用户这一次选的档位；空 = 还没选过，按下面的 effectivePermissionMode 显示。 */
  const [permissionMode, setPermissionMode] = useState("");
  /** 用户这一次选的模型目标；null = 没选过 = 跟随 Agent 绑定。 */
  const [modelTarget, setModelTarget] = useState<ModelTarget | null>(null);
  /** 这个后端支不支持会话级思考力度（执行端自报，openclaw 为假 → 整颗不摆）。 */
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(false);
  /**
   * 用户这一次选的思考力度；空 = 跟随后端配置。草稿态还没有会话行，所以它是**纯
   * 瞬态**的：随第一句一并过线（并由派发在 ack 之后补钉），发出前切走就随草稿消失。
   */
  const [reasoningEffort, setReasoningEffort] = useState("");

  const probeKey = `${chosen?.device_fingerprint ?? ""}|${chosen?.backend_type ?? ""}`;
  useAliveEffect(
    (alive) => {
      if (!client || relayState !== "connected" || !chosen?.backend_type)
        return;
      void client
        .request(rpcMethods.runtimeCapabilities, {
          backendType: chosen.backend_type,
        })
        .then((raw) => {
          if (!alive()) return;
          setPermissionModeMeta(decodePermissionModeMeta(raw));
          // 力度那一格在同一份应答的 capabilities 上。
          setSupportsReasoningEffort(decodeReasoningEffortSupport(raw));
        })
        // 报错与解不动是同一件事：这台机器此刻答不出档位。
        .catch(() => {
          if (!alive()) return;
          setPermissionModeMeta(null);
          setSupportsReasoningEffort(false);
        });
      // probeKey 覆盖了 chosen 的两个字段：换机器 / 换后端都要重问。
    },
    [client, relayState, chosen?.backend_type, probeKey],
  );

  /** 选中那一档对应的 Agent 后端行：模型的绑定值与档位的账号侧预设都在它上面。 */
  const engineBackend = useMemo(() => {
    const currentTier = plan?.tiers.find((tier) => tier.current);
    if (!currentTier?.backend_sync_id) return undefined;
    return backends.find((b) => b.sync_id === currentTier.backend_sync_id);
  }, [backends, plan]);

  /**
   * 起手值的归一化用共享包那一份：用户这次选的 → 账号侧那一档的预设 → 执行端报的
   * 默认档，且账号侧那一档必须在这台机器报的集合里才算数。
   *
   * 账号侧压在执行端前面，是因为 claudecode 报的 DefaultMode 是 runtime 能力矩阵
   * 里写死的常量（恒为 acceptEdits），不是「这台机器的偏好」；排在它后面等于管理员
   * 在 Agent 后端上配的档位永远够不着。而这一档会**显式**随第一句过线，执行端
   * CreatePermissionMode 收到非空值就直接采信，连它自己那条 backend 兜底也跳过 ——
   * 于是会话真的按错的档起手，不只是这一屏显示错。
   */
  const effectivePermissionMode = permissionModeMeta
    ? normalizePermissionMode(
        permissionMode,
        permissionModeMeta.allowedModes,
        permissionModeMeta.defaultMode,
        engineBackend?.default_permission_mode,
      )
    : permissionMode;

  /**
   * 后端配置的那一档，用户没选时由控件用它兜底显示（「→ 跟随后端配置 · <档位>」）。
   */
  const backendReasoningEffort = engineBackend?.reasoning_effort ?? "";

  /** 两格皆空 = 跟随 Agent 绑定。 */
  const effectiveTarget = useMemo<ModelTarget>(
    () => modelTarget ?? { providerKey: "", modelKey: "" },
    [modelTarget],
  );

  const projectName = useMemo(
    () => projects.find((p) => p.sync_id === projectSyncId)?.name ?? null,
    [projects, projectSyncId],
  );

  const start = useCallback(
    async (message: string) => {
      if (!readyPlan?.chosen || !message.trim()) return;
      setStarting(message);
      setStartError(null);
      try {
        const ticket = await ensureRelayTicket();
        const out = await dispatchNewConversation({
          plan: readyPlan,
          message,
          sourceClient: ticket,
          // 开局连上的那条就是派发要用的那条。连接还没到位（刚落定计划的一瞬）
          // 就照旧现开一条：这一句不该为了复用而等。
          client:
            relayState === "connected" ? (client ?? undefined) : undefined,
          // 档位只在这个后端**报出了**非空集合时才带：daemon 在 piagent 那一路把
          // 这个字段当远端 generation token 比对，塞一个真档位会让那一轮被判成
          // stale。闸门放在执行端自报的能力上，加新后端时这里一行都不用改。
          permissionMode:
            permissionModeMeta && permissionModeMeta.allowedModes.length > 0
              ? effectivePermissionMode
              : undefined,
          modelTarget: effectiveTarget,
          // 空 = 跟随后端配置，那本来就是不主张：既不带过线也不去钉。闸门与档位
          // 那一行同一条：**执行端报了这项能力**才带。挑完一档又把执行目标换成
          // openclaw 时，选过的值还留在 state 里，而 openclaw 的会话上不允许有
          // 力度（entity 层的既有校验）。
          reasoningEffort: supportsReasoningEffort ? reasoningEffort : "",
        });
        // 记在派发**成功之后**：开不起来的那次不算「用过」。
        rememberAgent(agent.sync_id);
        onStarted(out);
      } catch (e: unknown) {
        setStartError(e);
        // 提交那一刻输入框已经被清空，而占位是唯一显示这句话的地方——占位一撤，
        // 用户写的整段话就没了。把它还回输入框：字留在屏幕上、改得动、重发只差
        // 一次回车。SendFailureBubble 立的就是这条规矩。
        composerRef.current?.loadDraft(message);
        setStarting(null);
      }
    },
    [
      agent.sync_id,
      client,
      effectivePermissionMode,
      effectiveTarget,
      onStarted,
      permissionModeMeta,
      readyPlan,
      reasoningEffort,
      relayState,
      supportsReasoningEffort,
    ],
  );

  /**
   * @ 菜单里的 refId 只需在这一次渲染里稳定且唯一，用清单里的位置 ——
   * 与会话详情那边同一套算法（身份是字符串 sync_id，序列化出去靠 label 表意）。
   */
  const mentionAgents = useMemo(
    () =>
      agents.map((a, i) => ({
        id: i + 1,
        name: a.name,
        avatarColor: a.avatar_color,
      })),
    [agents],
  );

  /*
    meta 行：与详情那条同序（Agent → 项目），说得出哪几维就摆哪几维。机器不进这一行
    ——它在下面那枚可点的 chip 上，而那枚 chip 是**选择器**，不是一段陈述（桌面端
    空会话态同此：机器在 NewSessionExecTargetLine 上，不在头部）。
  */
  const metaParts: SessionHeaderMetaPart[] = [
    {
      key: "agent",
      node: (
        <span
          data-testid="draft-header-status"
          className="inline-flex shrink-0 items-center gap-1"
        >
          {/* 交出去那一刻就转绿：转录里三点已经在转了，两处说的是同一件事。 */}
          <StatusDot
            status={toAgentStatus({
              lifecycleState: starting ? "running" : "idle",
            })}
            size="xs"
          />
          {agent.name}
        </span>
      ),
    },
  ];
  if (projectName) {
    metaParts.push({
      key: "project",
      // 与详情那条同一个断点：项目在别处（下面那枚 chip、左栏的行上）还说得出。
      hideAt: "@max-[420px]/header:hidden",
      node: <span className="truncate">{projectName}</span>,
    });
  }

  return (
    <div
      data-testid="draft-session"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {/*
        顶带与会话详情**是同一副**（共享包的 SessionHeaderBand）：固定 68px、同一档
        头像、两行标题的高度、一行 mono meta。桌面端 chat-panel-header 的「四态同一
        副外壳」就是这一条 —— 这里此前是另一副（py-3 + 24px 头像），右栏顶上还另叠
        着一条 chat-chrome，第一句一发出去两条塌成一条，顶部 116px → 68px、头像
        24→32，转录整体上跳。

        右端收的是宿主那簇页面级控件：草稿这条带**就是**右栏的顶带，与详情落地后
        那条同一个位置，控件因此不跳。
      */}
      <SessionHeaderBand
        testId="draft-header"
        metaTestId="draft-header-meta"
        className="border-b border-border bg-card px-5"
        leading={
          onBack && (
            <button
              type="button"
              aria-label={t("chat.back")}
              className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
            </button>
          )
        }
        avatar={
          <AgentAvatar
            name={agent.name}
            initials={agent.name.charAt(0)}
            color={agent.avatar_color}
            icon={iconNode(agent.avatar_icon)}
            size="md"
          />
        }
        /*
          标题：还没交出去时是「新对话 · <Agent>」（与桌面端 newSessionTitle 同一句），
          交出去之后就换成**那句话本身**。第一句的标题由 deriveTitle 算，派发送过线
          的、账号里落库的、以及右栏落地后详情显示的都是同一个值 —— 所以这一刻换上
          去，右栏换成真详情时标题一个字都不动。
        */
        title={
          starting
            ? deriveTitle(starting)
            : t("chat.newSessionTitle", { name: agent.name })
        }
        meta={metaParts}
        actions={headerRight}
      />

      {starting ? (
        <DraftPending agent={agent} text={starting} />
      ) : (
        <div
          // 重算期间这一带摆的还是上一份计划：说出来，读屏据此不把它当定论
          // （屏幕上不换成骨架 —— 上一份仍然是同一个 Agent、同一台机器的答案）。
          aria-busy={!settled || undefined}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-6 py-8 text-center"
        >
          <p className="text-sm font-semibold text-foreground">
            {projectName
              ? t("chat.startWithAgentInProject", {
                  agent: agent.name,
                  project: projectName,
                })
              : t("chat.startWithAgent", { agent: agent.name })}
          </p>

          {planError ? (
            // 这条 effect 只在 agent/项目/执行档变化时重跑：没有这颗按钮的话，用户
            // 唯一的出路是去换个项目再换回来。
            <Alert variant="destructive" data-testid="draft-plan-failed">
              <AlertDescription className="flex min-w-0 flex-wrap items-center gap-3">
                <span className="min-w-0">
                  {planError instanceof ApiError
                    ? planError.message
                    : t("device.manage.loadError")}
                </span>
                <span className="flex-1" />
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setPlanAttempt((k) => k + 1)}
                >
                  {t("common.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : !plan ? (
            <p className="text-xs text-muted-foreground">
              {t("common.loading")}
            </p>
          ) : chosen ? (
            <>
              <ExecTargetLine
                plan={plan}
                overridden={!!targetBackendSyncId}
                onPick={(tier) =>
                  setTargetBackendSyncId(tier.backend_sync_id ?? null)
                }
                onAuto={() => setTargetBackendSyncId(null)}
              />
              <ProjectChip
                plan={plan}
                projectSyncId={projectSyncId}
                projectName={projectName}
                onPick={setProjectSyncId}
              />
            </>
          ) : targetBackendSyncId ? (
            <PickedTargetUnavailable
              plan={plan}
              targetBackendSyncId={targetBackendSyncId}
              onAuto={() => setTargetBackendSyncId(null)}
            />
          ) : (
            <AllTargetsUnavailable agentName={agent.name} tiers={plan.tiers} />
          )}
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-card px-5 py-3">
        <div className="mx-auto flex w-full max-w-measure flex-col gap-2.5">
          {/* 与会话详情**同一个**输入框组件：第一句和第二句该是同一件事 ——
              @ 提及、/ 命令、快捷键提示、发送键的启停规则，一份实现。
              backendType 来自挑中的那一档：斜杠命令菜单要按它过滤。 */}
          {composerModule && (
            <composerModule.default
              backendType={chosen?.backend_type}
              agents={mentionAgents}
              handleRef={composerRef}
              // 停用认的是**这一组入参**算出来的那一份：重算期间上面那些控件照旧
              // 摆着（它们是同一台机器的答案），但这一句要发到哪儿还没定。
              disabled={!readyPlan?.chosen || starting !== null}
              // 两颗控件只在**有选中的机器**时摆：没有机器就没有「哪个后端」这一
              // 问，此刻摆一颗禁用的 pill 是在暗示「有台机器只是暂时答不上来」。
              permissionModeMeta={chosen ? permissionModeMeta : undefined}
              permissionMode={effectivePermissionMode}
              permissionRuntimeKey={chosen?.backend_type}
              // 这条对话还没启动过 —— bypass 锁死规则的另一半在这里恒为假。
              permissionHasActiveSession={false}
              onPermissionModeChange={setPermissionMode}
              // 力度控件在**右侧**、紧邻提交键（规格 2026-09-01 决策 9）；同样只在
              // 有选中的机器、且那台机器报了这项能力时才摆。
              reasoningEffortControl={
                chosen && supportsReasoningEffort ? (
                  <SessionReasoningEffortControl
                    value={reasoningEffort}
                    backendValue={backendReasoningEffort}
                    onChange={setReasoningEffort}
                  />
                ) : undefined
              }
              modelControl={
                chosen ? (
                  <SessionModelControl
                    backendType={chosen.backend_type}
                    catalog={catalog}
                    boundProviderKey={engineBackend?.provider_key}
                    boundModelKey={engineBackend?.model_key}
                    target={effectiveTarget}
                    onChange={setModelTarget}
                  />
                ) : undefined
              }
              // 发不出去时如实说是哪一种：还在算计划、这次没问到、还是问到了但
              // 一档都不可用。后两者是两件事，合并等于替服务端下一个它没下的结论。
              disabledReason={
                readyPlan?.chosen
                  ? null
                  : planError
                    ? t("chat.planFailed")
                    : !settled || !plan
                      ? t("common.loading")
                      : t("overview.noAvailableTarget")
              }
              onSubmit={(text) => void start(text)}
              feedback={
                startError ? (
                  <p
                    role="alert"
                    className="border-t border-border px-3.5 py-1.5 text-xs text-destructive"
                  >
                    {startError instanceof DispatchRunError
                      ? t("chat.remoteStartFailed", {
                          machine: chosen?.device_name ?? "",
                          error: startError.message,
                        })
                      : t("chat.connectFailed", {
                          machine: chosen?.device_name ?? "",
                        })}
                  </p>
                ) : undefined
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 草稿这条对话在转录上下文里的号：这条对话还没有号（号由执行端在 `runtime.run`
 * 里定），而包只拿它当渲染上下文的键。编一个假号才是骗人。
 */
const DraftSessionId = 0;

/**
 * 派发在飞的那一段：**这条对话已经开始了**的样子。
 *
 * 与桌面端 `doSend` 同时插入 user + assistant 占位是同一件事，而且落的是同一批
 * 组件 —— 转录用 `Transcript`，三点用它的 `pendingAssistant`。所以派发一成功、
 * 右栏就地换成真会话详情时，用户刚说的那句话与三点是**接着**长下去的，不是从
 * 另一个形态跳过去的。
 *
 * 此前这里是空态原样留着、底下补一行小字「正在开始…」：输入框在提交那一刻已被
 * 清空，屏幕上一个字都没有他刚说的话。
 */
function DraftPending({ agent, text }: { agent: NewConvAgent; text: string }) {
  // 与右栏换成详情之后摆的那一条**同一个构造**：交接就发生在这两者之间，形不一致
  // 的话用户刚说完话就看见自己的气泡跳一下。
  const messages = useMemo<TranscriptMessage[]>(
    () => [pendingUserMessage(text, DraftSessionId)],
    [text],
  );
  return (
    <div
      data-testid="draft-pending"
      className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
    >
      <div className="mx-auto w-full max-w-measure">
        <Transcript
          messages={messages}
          sessionId={DraftSessionId}
          agentName={agent.name}
          agentAvatar={
            <AgentAvatar
              name={agent.name}
              color={agent.avatar_color}
              icon={iconNode(agent.avatar_icon)}
              className={MESSAGE_AVATAR_CLASS}
            />
          }
          streaming
          pendingAssistant
        />
      </div>
    </div>
  );
}

/** 「将在 [chip] 上运行」。chip 可点，打开「在哪台机器上跑」。 */
function ExecTargetLine({
  plan,
  overridden,
  onPick,
  onAuto,
}: {
  plan: DispatchPlan;
  overridden: boolean;
  onPick: (tier: DispatchTier) => void;
  onAuto: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chosen = plan.chosen;
  if (!chosen) return null;
  return (
    <p
      data-testid="draft-exec-target"
      className="flex flex-wrap items-center justify-center gap-1.5 text-[11.5px] text-muted-foreground"
    >
      {/* 整句一个键 + <Trans>：拆成「前缀 + chip + 后缀」两个键，英文的后缀就是
          空串（桌面端那边正是如此），而本仓库的 locale 守卫不许空翻译——更要紧的是
          语序本来就不该由代码写死。 */}
      <Trans
        i18nKey="chat.willRunOn"
        components={{
          1: (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-testid="draft-exec-target-chip"
                  aria-label={t("chat.pickTargetAria", {
                    label: chosen.device_name,
                  })}
                  className="inline-flex items-center gap-1.5 rounded-md bg-status-running-bg px-2 py-1 text-[11.5px] font-medium text-status-running-text transition-colors hover:ring-1 hover:ring-status-running"
                >
                  <Monitor aria-hidden="true" className="size-3" />
                  {chosen.device_name}
                  {chosen.backend_type && (
                    <span className="font-mono text-3xs font-normal text-muted-foreground">
                      {chosen.backend_type}
                    </span>
                  )}
                  <ChevronDown aria-hidden="true" className="size-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="center" className="w-72 p-1">
                <div className="px-2 pb-1.5 pt-1">
                  <p className="text-xs font-semibold text-foreground">
                    {t("chat.pickTargetTitle")}
                  </p>
                  <p className="text-[10.5px] text-muted-foreground">
                    {t("chat.pickTargetScope")}
                  </p>
                </div>
                <ul className="flex flex-col">
                  {plan.tiers.map((tier) => (
                    <li key={`${tier.rank}-${tier.backend_sync_id ?? ""}`}>
                      <TierOption
                        tier={tier}
                        onPick={() => {
                          onPick(tier);
                          setOpen(false);
                        }}
                      />
                    </li>
                  ))}
                </ul>
                {overridden && (
                  <button
                    type="button"
                    data-testid="draft-exec-target-auto"
                    className="mt-1 w-full border-t border-border px-2 py-1.5 text-left text-2xs text-primary-text hover:bg-accent"
                    onClick={() => {
                      onAuto();
                      setOpen(false);
                    }}
                  >
                    {t("chat.useAutoTarget")}
                  </button>
                )}
              </PopoverContent>
            </Popover>
          ),
        }}
      />
    </p>
  );
}

function TierOption({
  tier,
  onPick,
}: {
  tier: DispatchTier;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const usable = tier.availability === "available" && !!tier.backend_sync_id;
  const reason = availabilityReasonKey(tier.availability);
  return (
    <button
      type="button"
      data-testid={`draft-tier-${tier.rank}`}
      disabled={!usable}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]",
        usable ? "hover:bg-accent" : "cursor-not-allowed opacity-60",
        tier.current && "bg-sidebar-selected-bg",
      )}
    >
      <span className="w-2 shrink-0 font-mono text-[9.5px] text-decorative-foreground">
        {tier.rank}
      </span>
      <span className="truncate text-foreground">
        {tier.device_name ?? t("overview.thisDevice")}
      </span>
      {tier.backend_type && (
        <span className="font-mono text-3xs text-muted-foreground">
          {tier.backend_type}
        </span>
      )}
      {reason && (
        <span className="ml-auto shrink-0 text-[10.5px] text-status-waiting-text">
          {t(reason)}
        </span>
      )}
    </button>
  );
}

/** 「不指定项目 / <项目名>」。项目清单来自选中那台机器上已配好路径的那些。 */
function ProjectChip({
  plan,
  projectSyncId,
  projectName,
  onPick,
}: {
  plan: DispatchPlan;
  projectSyncId: string | null;
  projectName: string | null;
  onPick: (syncId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="draft-project-chip"
          className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-accent"
        >
          <FolderTree aria-hidden="true" className="size-3" />
          {projectName ?? t("chat.noProject")}
          <ChevronDown aria-hidden="true" className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-72 p-1">
        <p className="px-2 pb-1.5 pt-1 text-xs font-semibold text-foreground">
          {t("chat.pickProjectTitle")}
        </p>
        <ul className="flex flex-col">
          <li>
            <button
              type="button"
              data-testid="draft-project-none"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-accent",
                !projectSyncId && "bg-sidebar-selected-bg",
              )}
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
            >
              <span className="text-foreground">{t("chat.noProject")}</span>
              <span className="ml-auto text-[10.5px] text-muted-foreground">
                {t("chat.freeSession")}
              </span>
            </button>
          </li>
          {plan.projects.map((p) => (
            <li key={p.sync_id}>
              <button
                type="button"
                data-testid={`draft-project-${p.sync_id}`}
                className={cn(
                  "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12.5px] text-foreground hover:bg-accent",
                  projectSyncId === p.sync_id && "bg-sidebar-selected-bg",
                )}
                onClick={() => {
                  onPick(p.sync_id);
                  setOpen(false);
                }}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
        {plan.projects.length === 0 && (
          <p className="border-t border-border px-2 pb-1 pt-1.5 text-[10.5px] leading-[1.55] text-muted-foreground">
            {t("chat.noProjectsOnMachine")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 挑定的那一档跑不了。不回落到自动挑——回落等于悄悄换一台机器。 */
function PickedTargetUnavailable({
  plan,
  targetBackendSyncId,
  onAuto,
}: {
  plan: DispatchPlan;
  targetBackendSyncId: string;
  onAuto: () => void;
}) {
  const { t } = useTranslation();
  const tier = plan.tiers.find(
    (x) => x.backend_sync_id === targetBackendSyncId,
  );
  const reason = tier ? availabilityReasonKey(tier.availability) : null;
  return (
    <div
      data-testid="draft-picked-target-unavailable"
      className="flex max-w-measure flex-col gap-1.5 rounded-md border border-status-waiting bg-status-waiting-bg px-3 py-2.5 text-left"
    >
      <p className="text-xs font-semibold text-status-waiting-text">
        {t("chat.pickedTargetUnavailable", {
          machine: tier?.device_name ?? "",
        })}
      </p>
      {reason && <p className="text-2xs text-muted-foreground">{t(reason)}</p>}
      <button
        type="button"
        data-testid="draft-use-auto-target"
        className="self-start text-[11.5px] font-medium text-primary-text hover:underline"
        onClick={onAuto}
      >
        {t("chat.useAutoTarget")}
      </button>
    </div>
  );
}

/** 一档都不可用：逐档给原因，不静默失败（R15）。 */
function AllTargetsUnavailable({
  agentName,
  tiers,
}: {
  agentName: string;
  tiers: DispatchTier[];
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="draft-all-unavailable"
      className="flex max-w-measure flex-col gap-1.5 rounded-md border border-destructive bg-destructive-soft px-3 py-2.5 text-left"
    >
      <p className="text-xs font-semibold text-foreground">
        {t("chat.allUnavailableTitle", { agent: agentName })}
      </p>
      <ul className="flex flex-col gap-1">
        {tiers.map((tier) => {
          const reason = availabilityReasonKey(tier.availability);
          return (
            <li
              key={`${tier.rank}-${tier.backend_sync_id ?? ""}`}
              className="flex items-center gap-2 text-2xs text-muted-foreground"
            >
              <span className="font-mono text-3xs text-decorative-foreground">
                {tier.rank}
              </span>
              <span className="text-foreground">
                {tier.device_name ?? t("overview.thisDevice")}
              </span>
              {reason && <span className="ml-auto">{t(reason)}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
