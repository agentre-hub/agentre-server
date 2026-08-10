import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SendHorizonal } from "lucide-react";

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

interface Waiters {
  toolPermissions: PendingToolPermissionShape[];
  askUserQuestions: PendingAskQuestionShape[];
}

const ACTIVE = 1;

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
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [machineOnline, setMachineOnline] = useState<boolean | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [meValid, setMeValid] = useState(true);
  const probedRef = useRef(false);

  const clientRef = useRef<import("@/lib/relayClient").RelayClient | null>(
    null,
  );

  const refreshWaiters = useCallback(async (): Promise<Waiters | null> => {
    const c = clientRef.current;
    if (!c) return null;
    try {
      const raw = await c.request(MethodSessionPendingWaiters, {
        sessionId: sid,
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
        if (alive) setSummary(s ?? null);
        await client.attach(sid);
        await client.catchUp(sid);
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
        const my = res.devices.find(
          (d) => d.fingerprint === device?.fingerprint,
        );
        const machine = res.devices.find((d) => d.id === did);
        if (my && my.status !== ACTIVE) {
          markWebDeviceRevoked();
          setRevoked(true);
          return;
        }
        setMachineOnline(machine?.online ?? null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setMeValid(false);
      });
  }, [relayState, device?.fingerprint, did]);

  // 断线重连后刷新待决策：补齐只负责转录事件，pendingWaiters 需要重新拉一次（R10）。
  useEffect(() => {
    if (relayState === "connected" && ready) void refreshWaiters();
  }, [relayState, ready, refreshWaiters]);

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
    try {
      await c.request(MethodRun, {
        sessionId: sid,
        cwd: summary.cwd,
        title: summary.title,
        agentSyncId: summary.agentSyncId,
        userText: text.trim(),
        sourceDevice: webDevice.fingerprint,
        sourceDeviceName: deviceDisplayName(),
        backend: { backendType: summary.backendType },
      });
      setDraft("");
    } catch {
      // 发送失败保留草稿；连接状态由横幅表达。
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
          <Button variant="outline" size="sm" onClick={() => nav("/devices")}>
            {t("session.breadcrumb.switchMachine")}
          </Button>
        </nav>

        <SessionStatusBanner
          status={status}
          machineLastSeenMs={device?.last_seen_at}
        />

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
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage(draft);
              }}
            >
              <textarea
                aria-label={t("session.transcript.inputPlaceholder")}
                placeholder={t("session.transcript.inputPlaceholder")}
                className="min-h-10 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                value={draft}
                disabled={sending || status !== "connected"}
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
                disabled={sending || status !== "connected" || !draft.trim()}
                aria-label={t("session.transcript.send")}
              >
                <SendHorizonal aria-hidden="true" className="size-4" />
              </Button>
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
