import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bookmark, SendHorizonal } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import AppShell from "@/components/AppShell";
import DecisionPanel, {
  type AskAnswerSubmit,
  type PendingAskQuestionShape,
  type PendingToolPermissionShape,
} from "@/components/session/DecisionPanel";
import SessionStatusBanner from "@/components/session/SessionStatusBanner";
import Transcript from "@/components/session/Transcript";
import { useIsMobile } from "@/components/use-is-mobile";
import { useRelayMachine } from "@/hooks/use-relay";
import { api, ApiError } from "@/lib/api";
import { reduceEvents } from "@/lib/transcript";
import { deriveSessionViewStatus, statusDotClass } from "@/lib/sessionView";
import { browserDisplayName } from "@/lib/relayTicket";
import {
  decodeSessionListResult,
  decodeSessionPendingWaitersResult,
  MethodRun,
  MethodSessionList,
  MethodSessionPendingWaiters,
  MethodSubmitAnswer,
  MethodSubmitToolPermission,
  type EventFrame,
  type SessionSummary,
} from "@/lib/wire";
import { cn } from "@/lib/utils";

interface DeviceItem {
  id: number;
  name: string;
  kind: string;
  fingerprint: string;
  last_seen_at: number;
  status: number;
  online: boolean;
}

/** 关注名单（R14）里的「指向」：只含目标设备指纹 + 会话标识，不含标题/消息/转录。 */
interface FollowItem {
  device_fingerprint: string;
  session_id: string;
}

interface Waiters {
  toolPermissions: PendingToolPermissionShape[];
  askUserQuestions: PendingAskQuestionShape[];
}

/**
 * 会话详情视图的导航形态（任务 5 重构边界）：
 *   - "page"：路由页形态。包 AppShell（TopBar 标题 + SideNav），带面包屑/移动返回
 *     与移动顶栏关注入口（决策 16）。
 *   - "embedded"：桌面 Chat 右栏嵌入形态。不包 AppShell、无面包屑、无关注入口
 *     （关注在列表行 R12）；只渲染真实详情（标题/状态/转录/审批/Composer），由外层
 *     容器给尺寸。移动路由流程仍走 page 形态。
 */
export type SessionDetailViewForm = "page" | "embedded";

export interface SessionDetailViewProps {
  /** 目标设备（agentred）在账号下的 id。 */
  deviceId: number;
  /** 目标会话在 daemon 上的 id。 */
  sessionId: number;
  form?: SessionDetailViewForm;
}

/**
 * 可复用真实会话详情视图：attach + 按 seq 游标补齐（origin 原样带回 R4/R6）、
 * 实时事件、待审批/提问决策（R10）、发新消息（R9）、移动关注（R12/决策 16）、
 * 六类不可达状态（R11）都在这一份实现里，路由页与桌面右栏共用，不回退。
 *
 * 详情头部对齐正式画板（X9Mjl/uqEha 的 DetailHeader）：标题 + 状态标记 + 机器 meta。
 * 画板中无协议支持的「分享链接 / more」按钮、文件改动面板、自动挂起倒计时、权限模式、
 * 会话轮次、快速提示词一律不渲染（规格「任务必要性 + 真实能力」双重判定）。
 */
export default function SessionDetailView({
  deviceId,
  sessionId,
  form = "page",
}: SessionDetailViewProps) {
  const did = Number(deviceId);
  const sid = Number(sessionId);
  const { t } = useTranslation();
  const nav = useNavigate();
  const isPage = form === "page";
  const isMobile = useIsMobile();

  const [device, setDevice] = useState<DeviceItem | null>(null);
  const [deviceError, setDeviceError] = useState<unknown>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<EventFrame[]>([]);
  const [waiters, setWaiters] = useState<Waiters>({
    toolPermissions: [],
    askUserQuestions: [],
  });
  const [handledRequestId, setHandledRequestId] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  // 桌面端仍在场时写失败：表示该会话钉住的 agentred 当前不可用（历史可读、新写入停用）。
  const [pinnedAgentredUnavailable, setPinnedAgentredUnavailable] =
    useState(false);
  // 未升级的 agentred 的 session.list 应答里没有 supportsSessionMetadata（兼容性）。
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [machineOnline, setMachineOnline] = useState<boolean | null>(null);
  const [meValid, setMeValid] = useState(true);
  const [followed, setFollowed] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  // 已装载的目标会话标识：桌面 Chat 右栏点行 A 再点行 B 时是同实例换 props（无
  // key 强制重挂），会话级状态必须随 (did, sid) 变化重置，否则右栏残留上一条会话的
  // 标题/转录/决策，发消息也落在上一条的 origin 上。用 React 官方的「prop 变化时
  // 重置 state」渲染期调整模式（不能在 effect 里裸调 setState —— lint 禁止）。
  // 设备/账号级状态（machineOnline / meValid）不在此列，由各自 effect 随
  // did 刷新。originRef 由 attach effect 每次重新推导，不需要在这里清。
  const [lastTarget, setLastTarget] = useState({ did, sid });
  if (lastTarget.did !== did || lastTarget.sid !== sid) {
    setLastTarget({ did, sid });
    setSummary(null);
    setEvents([]);
    setWaiters({ toolPermissions: [], askUserQuestions: [] });
    setHandledRequestId(null);
    setDecisionError(false);
    setSendError(false);
    setPinnedAgentredUnavailable(false);
    setNeedsUpgrade(false);
    setDraft("");
    setFollowed(false);
    setFollowBusy(false);
    setReady(false);
  }
  const probedRef = useRef(false);

  const clientRef = useRef<import("@/lib/relayClient").RelayClient | null>(
    null,
  );
  /**
   * 别的对端发起的会话（R4：清单列的是这台机器上的**全部**会话）在 daemon 上的键是
   * (发起端指纹, 会话 id)。清单在 summary.peerFingerprint 上交出这个 origin，此后
   * 每一次 attach / pull / 控制请求与 runtime.run 都要原样带回 —— 省略即
   * 「调用方自己的对端」，操作的会是本浏览器名下那条同号空会话。
   */
  const originRef = useRef<string | undefined>(undefined);

  const refreshWaiters = useCallback(async (): Promise<Waiters | null> => {
    const c = clientRef.current;
    if (!c) return null;
    try {
      const raw = await c.request(MethodSessionPendingWaiters, {
        sessionId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      });
      const res = decodeSessionPendingWaitersResult(raw);
      const next: Waiters = {
        toolPermissions: (res.toolPermissions ??
          []) as PendingToolPermissionShape[],
        askUserQuestions: (res.askUserQuestions ??
          []) as PendingAskQuestionShape[],
      };
      setWaiters(next);
      // 「已被处理」是对**那一条**待决策的说明,不是页面的永久状态:新的待决策上来
      // 之后还挂着,就成了「已被处理」与一张真等着人批的卡并排自相矛盾。
      if (next.toolPermissions.length > 0 || next.askUserQuestions.length > 0) {
        setHandledRequestId(null);
      }
      return next;
    } catch {
      // 拉不到是「没问出来」,不是「没有待决策」:回 null 让调用方自己分辨,
      // 别把一次 RPC 失败当成待决策已经被处理。
      return null;
    }
  }, [sid]);

  const refreshWaitersRef = useRef(refreshWaiters);
  // 每次渲染后把最新 refreshWaiters 收进 ref，供实时回调（onRunResultDone 等）调用。
  useEffect(() => {
    refreshWaitersRef.current = refreshWaiters;
  });

  const { client, relayState, relayTicket, relayTicketError } = useRelayMachine(
    device?.online ? device.fingerprint : null,
    {
      onEvent: (f) => {
        if (f.sessionId === sid) setEvents((prev) => [...prev, f]);
        // 审批/提问事件到达时刷新待决策:DecisionPanel 的数据源是 pendingWaiters,
        // 不是事件流 —— 不主动重拉,审批卡就永远不出现(fake runtime 阻塞在审批上,
        // run 不会结束,onRunResultDone 那一条刷新路径到不了;R10)。
        const kind = (f.event as { kind?: string } | undefined)?.kind;
        if (
          kind === "tool_permission_request" ||
          kind === "ask_user_question"
        ) {
          void refreshWaitersRef.current();
        }
      },
      onRunResultDone: () => {
        setEvents((prev) => [
          ...prev,
          { sessionId: sid, event: { kind: "done" }, seq: undefined },
        ]);
        void refreshWaitersRef.current();
      },
      onAutonomousTurnStarted: () => {
        void refreshWaitersRef.current();
      },
    },
  );

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  // 取设备。换设备时同时重新允许一次 reconnecting 原因探测（R11）——旧设备的探测
  // 结论不属于新设备。
  useEffect(() => {
    probedRef.current = false;
    let alive = true;
    api<{ devices: DeviceItem[] }>("/v1/devices")
      .then((res) => {
        if (!alive) return;
        const found = res.devices.find((d) => d.id === did);
        if (found) {
          setDevice(found);
          setMachineOnline(found.online);
          // 上一次取数失败（网络抖动）留下的错误必须清掉：不清的话，嵌入右栏
          // 从那次失败起永久卡在错误态——之后切到哪台机器、取数多成功都只显示
          // 旧错误，只能整页刷新救回。
          setDeviceError(null);
        } else {
          setDeviceError(new Error("device not found"));
        }
      })
      .catch((e: unknown) => {
        if (alive) setDeviceError(e);
      });
    return () => {
      alive = false;
    };
  }, [did]);

  // 已连接 → 取会话摘要 → attach（显式接管）→ 按 seq 游标补齐转录（R6）。
  useEffect(() => {
    if (!client || relayState !== "connected" || ready) return;
    let alive = true;
    (async () => {
      try {
        const listRaw = await client.request(MethodSessionList);
        const list = decodeSessionListResult(listRaw);
        const s = list.sessions.find((x) => x.sessionId === sid);
        // origin 在 attach 之前就得学到（下一行就要用它）。
        const origin = s?.peerFingerprint?.trim() || undefined;
        originRef.current = origin;
        if (alive) {
          setSummary(s ?? null);
          // 老 agentred 落库不了 provider_session_id：从这里发消息续不上上下文。
          // 如实说明它需要升级，并停用发送——不静默发出去（兼容性）。桌面端无此问题。
          setNeedsUpgrade(
            device?.kind !== "desktop" && !list.supportsSessionMetadata,
          );
        }
        await client.attach(sid, origin);
        await client.catchUp(sid, origin);
        if (alive) {
          setReady(true);
          // 待决策刷新交给下面的「connected && ready」effect，避免重复拉取。
        }
      } catch {
        // 补齐失败不打断重连；重连后会自动再走一遍 attach + catchUp。
      }
    })();
    return () => {
      alive = false;
    };
    // ready 之后不再重复跑（重连时的补齐由 RelayClient.reconnect 对 watched 会话负责）；
    // ready / did / sid 也必须是依赖：切换会话时上面的渲染期重置把 ready 置 false，
    // 这里要重新 attach 到新会话；只按 [client, relayState] 的话重置后不会重跑。
    // device?.kind 也要进来：桌面端不存在老 agentred 的升级判定，取数完成后须重算。
  }, [client, relayState, ready, did, sid, device?.kind]);

  // 首次进入 reconnecting（= 连接失败）时探测原因（R11），只探一次。
  // 与文件里其它异步 effect 一样带 alive 守卫：reconnecting 期间切换目标设备或
  // 卸载时，旧设备那次还在路上的探测不得把 machineOnline / meValid 覆盖成旧目标
  // （或卸载后）的结论。
  useEffect(() => {
    if (relayState !== "reconnecting" || probedRef.current) return;
    probedRef.current = true;
    let alive = true;
    api<{ devices: DeviceItem[] }>("/v1/devices")
      .then((res) => {
        if (!alive) return;
        const machine = res.devices.find((d) => d.id === did);
        setMachineOnline(machine?.online ?? null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setMeValid(false);
      });
    return () => {
      alive = false;
    };
  }, [relayState, did]);

  // 断线重连后刷新待决策：补齐只负责转录事件，pendingWaiters 需要重新拉一次（R10）。
  useEffect(() => {
    if (relayState === "connected" && ready) void refreshWaiters();
  }, [relayState, ready, refreshWaiters]);

  // 关注入口：桌面在列表行（R12），移动在详情页顶栏（决策 16）。只在页面形态
  // 渲染关注开关，因此需要知道这条会话当前是否在账号级名单里（R14）。嵌入形态
  // （桌面右栏）关注留在列表行，不拉名单。
  useEffect(() => {
    if (!isPage || !device) return;
    let alive = true;
    api<{ items: FollowItem[] }>("/v1/follows")
      .then((res) => {
        if (!alive) return;
        setFollowed(
          res.items.some(
            (f) =>
              f.device_fingerprint === device.fingerprint &&
              f.session_id === String(sid),
          ),
        );
      })
      .catch(() => {
        // 拉不到名单时保持未关注；用户可手动操作，失败不打断页面。
      });
    return () => {
      alive = false;
    };
  }, [isPage, device, sid]);

  // 关注 / 取消关注（R12）：成功后翻本地状态；失败保持原样，用户可重试。
  async function toggleFollow() {
    if (!device) return;
    setFollowBusy(true);
    try {
      await api(`/v1/follows${followed ? "/unfollow" : ""}`, {
        method: "POST",
        body: JSON.stringify({
          device_fingerprint: device.fingerprint,
          session_id: String(sid),
        }),
      });
      setFollowed((prev) => !prev);
    } catch {
      // 失败保持原样。
    } finally {
      setFollowBusy(false);
    }
  }

  const status = deriveSessionViewStatus({
    relayState,
    meValid:
      meValid &&
      !(
        relayTicketError instanceof ApiError && relayTicketError.status === 401
      ),
    machineOnline,
    targetKind: device?.kind,
    pinnedAgentredUnavailable,
  });

  const items = useMemo(() => reduceEvents(events), [events]);

  // R9：给会话发新消息（不需要发起端在线；上下文由 agentred 侧的
  // providerSessionID 续上，决策 8）。
  async function sendMessage(text: string) {
    const c = clientRef.current;
    if (!c || !summary || !relayTicket || !text.trim()) return;
    setSending(true);
    setSendError(false);
    try {
      await c.request(MethodRun, {
        sessionId: sid,
        // R9：这一轮要落在**发起端**那条会话上，才续得上它的上下文、也才扇出给
        // 同一条会话的其余订阅者（R6 / R18）。
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
        cwd: summary.cwd,
        title: summary.title,
        agentSyncId: summary.agentSyncId,
        userText: text.trim(),
        sourceDevice: relayTicket.clientId,
        sourceDeviceName: browserDisplayName(),
        backend: { type: summary.backendType },
      });
      setDraft("");
      setPinnedAgentredUnavailable(false);
    } catch {
      // 桌面端仍在场时，写失败表示这条会话钉住的 agentred 当前不可用：历史继续
      // 保持可读，但停用新写入并给出专门说明。agentred 目标保留既有发送失败措辞。
      if (device?.kind === "desktop") {
        setPinnedAgentredUnavailable(true);
      } else {
        // 保留草稿，并就地说明这一条没发出去——静默吞掉会让用户以为已经发了。
        setSendError(true);
      }
    } finally {
      setSending(false);
    }
  }

  // R10：提交决策前先确认该待决策还在；已被别的端回答过 → 就地说明已被处理并
  // 刷新状态，而不是报错或静默失败。
  async function submitDecision(
    requestId: string,
    doSubmit: () => Promise<unknown>,
  ) {
    setHandledRequestId(null);
    setDecisionError(false);
    const before = await refreshWaiters();
    // before 为 null = 预检这一次没问出来（RPC 失败），不是「已经被处理」。当成
    // 已处理收场会把这次决策静默丢掉，而那边的工具还阻塞着。问不出来就照常提交，
    // 重复提交由 daemon 的幂等收敛（R8）。
    const answered =
      before !== null &&
      !before.toolPermissions.some((w) => w.RequestID === requestId) &&
      !before.askUserQuestions.some((w) => w.RequestID === requestId);
    if (answered) {
      setHandledRequestId(requestId);
      return;
    }
    try {
      await doSubmit();
    } catch {
      // 提交没发出去（socket 刚断等）：就地说明，不静默——按钮点下去什么都不发生
      // 会让用户以为批准生效了，而工具还阻塞在那台机器上。
      setDecisionError(true);
    } finally {
      await refreshWaiters();
    }
  }

  function approveTool(
    requestId: string,
    opts: { allow: boolean; alwaysAllow: boolean; denyReason?: string },
  ) {
    void submitDecision(requestId, () =>
      clientRef.current!.request(MethodSubmitToolPermission, {
        sessionId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
        requestId,
        allow: opts.allow,
        alwaysAllowSession: opts.alwaysAllow,
        denyReason: opts.denyReason,
      }),
    );
  }

  function answerQuestion(
    requestId: string,
    answers: AskAnswerSubmit[],
    skipped: boolean,
  ) {
    void submitDecision(requestId, () =>
      clientRef.current!.request(MethodSubmitAnswer, {
        sessionId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
        requestId,
        answers,
        skipped,
      }),
    );
  }

  if (deviceError) {
    const alert = (
      <Alert variant="destructive">
        {deviceError instanceof ApiError
          ? deviceError.message
          : t("device.manage.loadError")}
      </Alert>
    );
    // 页面形态连壳一起报错；嵌入形态直接就地报错（外层容器给尺寸）。
    return isPage ? <AppShell>{alert}</AppShell> : alert;
  }

  const showTranscript =
    ready &&
    (status === "connected" ||
      status === "pinnedAgentredUnavailable" ||
      relayState === "reconnecting");

  // 详情头部的机器 meta：「设备 · 在线/离线」拼成同一文本节点(jsx-only 守卫要求
  // 文案不出现裸字符串;分隔符在 JS 里拼,不进 JSX)。
  const machineMeta = device?.name
    ? [
        device.name,
        machineOnline === false
          ? t("session.breadcrumb.offline")
          : machineOnline === true
            ? t("session.breadcrumb.online")
            : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  const content = (
    <>
      {isPage && (
        /* 路由页导航（决策 16，屏 22）：移动返回 + 设备名 + 关注；桌面面包屑。 */
        <nav
          aria-label={t("session.breadcrumb.devices")}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          {isMobile ? (
            <>
              {/* 下钻三联的返回：设备 → 这台机器的对话 → 对话详情（决策 16，屏 22）。 */}
              <Link
                to={`/devices/${did}/sessions`}
                aria-label={t("session.breadcrumb.back")}
                className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="size-5" aria-hidden="true" />
              </Link>
              <span className="truncate font-semibold text-foreground">
                {device?.name ?? ""}
              </span>
              <span
                className={
                  machineOnline === false
                    ? "text-destructive"
                    : "text-status-waiting"
                }
              >
                {machineOnline === false
                  ? t("session.breadcrumb.offline")
                  : t("session.breadcrumb.online")}
              </span>
              <span className="flex-1" />
              {/* 决策 16：移动的关注入口在详情页顶栏。 */}
              {device && (
                <Button
                  variant="outline"
                  onClick={() => void toggleFollow()}
                  disabled={followBusy}
                >
                  <Bookmark
                    className="size-4"
                    fill={followed ? "currentColor" : "none"}
                    aria-hidden="true"
                  />
                  {t(followed ? "chat.unfollow" : "chat.follow")}
                </Button>
              )}
            </>
          ) : (
            <>
              <Link
                to="/devices"
                className="font-medium text-muted-foreground hover:text-foreground"
              >
                {t("session.breadcrumb.devices")}
              </Link>
              <span aria-hidden="true" className="text-subtle-foreground">
                /
              </span>
              <Link
                to={`/devices/${did}/sessions`}
                className="font-medium text-muted-foreground hover:text-foreground"
              >
                {device?.name ?? ""}
              </Link>
              <span className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => nav("/devices")}
              >
                {t("session.breadcrumb.switchMachine")}
              </Button>
            </>
          )}
        </nav>
      )}

      {/* 详情头部（正式画板 DetailHeader）：标题 + 状态标记 + 机器 meta。
          页面形态的标题由 AppShell TopBar 呈现，不在这里重复；嵌入形态无 TopBar，
          标题落在这里。 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {!isPage && (
          <h2 className="truncate text-lg font-bold text-foreground">
            {summary?.title ?? `#${sid}`}
          </h2>
        )}
        {summary?.lifecycleState && (
          <span
            data-testid="session-detail-status"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                statusDotClass({
                  lifecycleState: summary.lifecycleState,
                  waitingForInput: summary.waitingForInput,
                }),
              )}
            />
            {/* 状态不只靠颜色：等待输入/运行/中断/空闲都有可见文字（session.list.*）。 */}
            {summary.waitingForInput
              ? t("session.list.waiting")
              : summary.lifecycleState === "running"
                ? t("session.list.running")
                : summary.lifecycleState === "interrupted"
                  ? t("session.list.interrupted")
                  : t("session.list.idle")}
          </span>
        )}
        {machineMeta && (
          <span
            data-testid="session-detail-meta"
            className="text-xs text-subtle-foreground"
          >
            {machineMeta}
          </span>
        )}
      </div>

      <SessionStatusBanner
        status={status}
        machineLastSeenMs={device?.last_seen_at}
      />

      {/* 兼容性：这台机器没升级 —— 会话只能退化显示、也发不了新消息，如实说明。 */}
      {showTranscript && needsUpgrade && (
        <Alert role="status">{t("session.needsUpgrade")}</Alert>
      )}

      {showTranscript && (
        <>
          <Transcript items={items} />
          {waiters.toolPermissions.length > 0 ||
          waiters.askUserQuestions.length > 0 ||
          handledRequestId ? (
            <>
              <DecisionPanel
                toolPermissions={waiters.toolPermissions}
                askUserQuestions={waiters.askUserQuestions}
                handledRequestId={handledRequestId}
                onApproveTool={approveTool}
                onAnswerQuestion={answerQuestion}
              />
              {decisionError && (
                <p role="alert" className="text-xs text-destructive">
                  {t("session.decision.submitFailed")}
                </p>
              )}
            </>
          ) : null}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage(draft);
            }}
          >
            <textarea
              data-testid="session-detail-composer"
              aria-label={t("session.transcript.inputPlaceholder")}
              placeholder={t("session.transcript.inputPlaceholder")}
              className="min-h-10 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              value={draft}
              disabled={sending || status !== "connected" || needsUpgrade}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage(draft);
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              data-testid="session-detail-send"
              disabled={
                sending ||
                status !== "connected" ||
                needsUpgrade ||
                !draft.trim()
              }
              aria-label={t("session.transcript.send")}
            >
              <SendHorizonal aria-hidden="true" className="size-4" />
            </Button>
            {sendError && (
              <p role="alert" className="w-full text-xs text-destructive">
                {t("session.sendFailed")}
              </p>
            )}
          </form>
        </>
      )}
      {status === "connecting" && (
        <p className="text-sm text-muted-foreground">
          {t("session.transcript.loading")}
        </p>
      )}
    </>
  );

  if (isPage) {
    return (
      <AppShell title={summary?.title ?? `#${sid}`}>
        <div className="mx-auto w-full max-w-3xl space-y-5">{content}</div>
      </AppShell>
    );
  }

  // 嵌入形态（桌面 Chat 右栏）：无壳，垂直填满外层容器，内容自己滚动。
  return (
    <div
      data-testid="session-detail-view"
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto"
    >
      {content}
    </div>
  );
}
