import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import { deriveSessionViewStatus } from "@/lib/sessionView";
import {
  deviceDisplayName,
  WebDeviceRevokedError,
  markWebDeviceRevoked,
} from "@/lib/webDevice";
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

export default function SessionDetail() {
  const { deviceId, sessionId } = useParams();
  const did = Number(deviceId);
  const sid = Number(sessionId);
  const { t } = useTranslation();
  const nav = useNavigate();

  const [device, setDevice] = useState<DeviceItem | null>(null);
  const [deviceError, setDeviceError] = useState<unknown>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<EventFrame[]>([]);
  const [waiters, setWaiters] = useState<Waiters>({
    toolPermissions: [],
    askUserQuestions: [],
  });
  const [handledRequestId, setHandledRequestId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  // 未升级的 agentred 的 session.list 应答里没有 supportsSessionMetadata（兼容性）。
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [machineOnline, setMachineOnline] = useState<boolean | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [meValid, setMeValid] = useState(true);
  const [followed, setFollowed] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const probedRef = useRef(false);
  const isMobile = useIsMobile();

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
      return next;
    } catch {
      return null;
    }
  }, [sid]);

  const refreshWaitersRef = useRef(refreshWaiters);
  // 每次渲染后把最新 refreshWaiters 收进 ref，供实时回调（onRunResultDone 等）调用。
  useEffect(() => {
    refreshWaitersRef.current = refreshWaiters;
  });

  const { client, relayState, webDevice, webDeviceError } = useRelayMachine(
    device?.fingerprint ?? null,
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

  // 取设备。
  useEffect(() => {
    let alive = true;
    api<{ devices: DeviceItem[] }>("/v1/devices")
      .then((res) => {
        if (!alive) return;
        const found = res.devices.find((d) => d.id === did);
        if (found) {
          setDevice(found);
          setMachineOnline(found.online);
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
          // 如实说明它需要升级，并停用发送——不静默发出去（兼容性）。
          setNeedsUpgrade(!list.supportsSessionMetadata);
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
    // ready 之后不再重复跑（重连时的补齐由 RelayClient.reconnect 对 watched 会话负责）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, relayState]);

  // 首次进入 reconnecting（= 连接失败）时探测原因（R11），只探一次。
  useEffect(() => {
    if (relayState !== "reconnecting" || probedRef.current) return;
    probedRef.current = true;
    api<{ devices: DeviceItem[] }>("/v1/devices")
      .then((res) => {
        // R2 / R11：/v1/devices 只回**活跃**设备，被解除授权的行直接不在里面。
        // 因此判据是「自己这台还在不在清单里」，不是它的 status——按 status 判
        // 永远判不出来，那个分支不可达。指纹还没取到时不判（避免误报）。
        const myFingerprint = webDevice?.fingerprint;
        if (
          myFingerprint &&
          !res.devices.some((d) => d.fingerprint === myFingerprint)
        ) {
          markWebDeviceRevoked();
          setRevoked(true);
          return;
        }
        const machine = res.devices.find((d) => d.id === did);
        setMachineOnline(machine?.online ?? null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMeValid(false);
      });
  }, [relayState, webDevice?.fingerprint, did]);

  // 断线重连后刷新待决策：补齐只负责转录事件，pendingWaiters 需要重新拉一次（R10）。
  useEffect(() => {
    if (relayState === "connected" && ready) void refreshWaiters();
  }, [relayState, ready, refreshWaiters]);

  // 关注入口：桌面在列表行（R12），移动在详情页顶栏（决策 16）。本页只在移动上
  // 渲染关注开关，因此需要知道这条会话当前是否在账号级名单里（R14）。
  useEffect(() => {
    if (!device) return;
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
  }, [device, sid]);

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

  const revokedNow = revoked || webDeviceError instanceof WebDeviceRevokedError;
  const status = deriveSessionViewStatus({
    relayState,
    meValid,
    webDeviceRevoked: revokedNow,
    machineOnline,
  });

  const items = useMemo(() => reduceEvents(events), [events]);

  // R9：给会话发新消息（不需要发起端在线；上下文由 agentred 侧的
  // providerSessionID 续上，决策 8）。
  async function sendMessage(text: string) {
    const c = clientRef.current;
    if (!c || !summary || !webDevice || !text.trim()) return;
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
        sourceDevice: webDevice.fingerprint,
        sourceDeviceName: deviceDisplayName(),
        backend: { type: summary.backendType },
      });
      setDraft("");
    } catch {
      // 保留草稿，并就地说明这一条没发出去——静默吞掉会让用户以为已经发了。
      setSendError(true);
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
    const before = await refreshWaiters();
    const present = !!(
      before &&
      (before.toolPermissions.some((w) => w.RequestID === requestId) ||
        before.askUserQuestions.some((w) => w.RequestID === requestId))
    );
    if (!present) {
      setHandledRequestId(requestId);
      return;
    }
    try {
      await doSubmit();
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
    return (
      <AppShell>
        <Alert variant="destructive">
          {deviceError instanceof ApiError
            ? deviceError.message
            : t("device.manage.loadError")}
        </Alert>
      </AppShell>
    );
  }

  const showTranscript =
    ready && (status === "connected" || relayState === "reconnecting");

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl space-y-5">
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
              <span aria-hidden="true" className="text-subtle-foreground">
                /
              </span>
              <span className="max-w-[40vw] truncate font-semibold text-foreground">
                {summary?.title ?? `#${sid}`}
              </span>
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
              <DecisionPanel
                toolPermissions={waiters.toolPermissions}
                askUserQuestions={waiters.askUserQuestions}
                handledRequestId={handledRequestId}
                onApproveTool={approveTool}
                onAnswerQuestion={answerQuestion}
              />
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
      </div>
    </AppShell>
  );
}
