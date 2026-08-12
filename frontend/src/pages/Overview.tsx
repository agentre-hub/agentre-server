import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Clock3,
  Gauge,
  Monitor,
  ScrollText,
  ShieldCheck,
} from "lucide-react";

import { EmptyState, Metric } from "@/components/console";
import { Alert } from "@/components/ui/alert";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { sessionTitle } from "@/components/session/SessionList";
import type {
  PendingAskQuestionShape,
  PendingToolPermissionShape,
} from "@/components/session/DecisionPanel";
import { useRelayMachine } from "@/hooks/use-relay";
import { api, ApiError } from "@/lib/api";
import type { RelayClient } from "@/lib/relayClient";
import { formatRelativeTime } from "@/lib/sessionView";
import { cn } from "@/lib/utils";
import {
  MethodSessionList,
  MethodSessionPendingWaiters,
  MethodSubmitToolPermission,
  decodeSessionListResult,
  decodeSessionPendingWaitersResult,
  type SessionSummary,
} from "@/lib/wire";

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

interface DeviceItem {
  id: number;
  name: string;
  kind: string;
  fingerprint: string;
  online: boolean;
}

interface FollowItem {
  device_fingerprint: string;
  session_id: string;
  invalid: boolean;
}

/** 一条在等待用户输入的关注会话（等待数统计与操作条卡的共同来源）。 */
interface WaitingSessionInfo {
  fingerprint: string;
  session: SessionSummary;
}

/** 中继 pendingWaiters 解析出的待决策（动作按钮据此渲染，不伪造）。 */
interface WaiterData {
  toolPermissions: PendingToolPermissionShape[];
  askUserQuestions: PendingAskQuestionShape[];
}

/** 操作条里的一张卡：能链接到详情页、且 waiters 已取到的等待会话。 */
interface ActionCard {
  key: string;
  fingerprint: string;
  sessionId: number;
  origin?: string;
  title: string;
  cwd?: string;
  agentName: string;
  waitedAt?: number;
  waiters: WaiterData;
  detailPath: string;
}

function loadErrorText(e: unknown, t: (key: string) => string): string {
  return e instanceof ApiError ? e.message : t("overview.loadError");
}

/** 无数据源区块的诚实空态：不编数字，只给一个占位符。 */
const NO_DATA = "—";

/** 等待时长（分钟）。没有 updatedAt 时返回 0，调用方据此隐藏。 */
function waitedMinutes(updatedAt: number | undefined): number {
  if (!updatedAt) return 0;
  return Math.max(1, Math.round((Date.now() - updatedAt) / 60000));
}

/** waiters 的键：会话 id 是 daemon 局部计数，两台 agentred 可以各自有一条同号
 *  会话 —— 只按 sessionId 记会把一台机器的待决策盖到另一台机器同号会话的卡上，
 *  Allow/Deny 提交到错机器。键必须带设备指纹。 */
function waiterKey(fingerprint: string, sessionId: number): string {
  return `${fingerprint}:${sessionId}`;
}

// ── TopBar 的 Fresh 指示 ────────────────────────────────────────────────
// 桌面端（agentred）有在线机器才算「已连接」；未连 / 未知则不渲染，不编状态。
function Fresh({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  if (!connected) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-[6px] rounded-full bg-status-running"
      />
      <span className="text-xs text-muted-foreground">
        {t("appShell.topBar.fresh")}
      </span>
    </span>
  );
}

// ── 琥珀色「等你处理」操作条 ────────────────────────────────────────────
function ActionStrip({
  cards,
  onAllow,
  onDeny,
}: {
  cards: ActionCard[];
  onAllow: (card: ActionCard) => void;
  onDeny: (card: ActionCard) => void;
}) {
  const { t, i18n } = useTranslation();
  if (cards.length === 0) return null;

  const longest = Math.max(...cards.map((c) => waitedMinutes(c.waitedAt)), 0);

  return (
    <div className="flex flex-col gap-[11px] rounded-lg border border-status-waiting/40 bg-status-waiting-bg p-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-status-waiting">
          {t("overview.actionStrip.title", { count: cards.length })}
        </span>
        <span className="flex-1" />
        <span className="text-xs text-status-waiting">
          {t("overview.actionStrip.sub", { minutes: longest })}
        </span>
        <Link
          to="/chat"
          className="text-xs font-medium text-status-waiting hover:underline"
        >
          {t("overview.actionStrip.all")}
        </Link>
      </div>
      <div className="flex flex-col gap-[11px] md:flex-row">
        {cards.map((card) => (
          <ActionCardView
            key={card.key}
            card={card}
            onAllow={() => onAllow(card)}
            onDeny={() => onDeny(card)}
            t={t}
            i18nLanguage={i18n.language}
          />
        ))}
      </div>
    </div>
  );
}

function ActionCardView({
  card,
  onAllow,
  onDeny,
  t,
  i18nLanguage,
}: {
  card: ActionCard;
  onAllow: () => void;
  onDeny: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  i18nLanguage: string;
}) {
  const hasTool = card.waiters.toolPermissions.length > 0;
  const hasQuestion = card.waiters.askUserQuestions.length > 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-md border border-border bg-card p-3">
      <span className="truncate text-[13px] font-semibold text-foreground">
        {card.title}
      </span>
      {card.cwd?.trim() ? (
        <span className="truncate font-mono text-[11px] text-subtle-foreground">
          {card.cwd}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {card.agentName}
        </span>
        {card.waitedAt ? (
          <span className="shrink-0 text-[11px] text-subtle-foreground">
            {formatRelativeTime(card.waitedAt, i18nLanguage)}
          </span>
        ) : null}
        <span className="flex-1" />
        {hasTool && (
          <>
            <Button size="xs" onClick={onAllow}>
              {t("overview.actionCard.allow")}
            </Button>
            <Button size="xs" variant="outline" onClick={onDeny}>
              {t("overview.actionCard.deny")}
            </Button>
          </>
        )}
        {hasQuestion && (
          <Button size="xs" asChild>
            <Link to={card.detailPath}>{t("overview.actionCard.reply")}</Link>
          </Button>
        )}
        <Button size="xs" variant="ghost" asChild>
          <Link to={card.detailPath}>
            {t("overview.actionCard.viewDetails")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ── 每台在线且有关注的机器一个中继解析器（镜像 Chat 页的 FollowedMachineResolver） ──
function MachineResolver({
  fingerprint,
  ids,
  onResolved,
  onClient,
  onClearClient,
}: {
  fingerprint: string;
  ids: string[];
  onResolved: (fp: string, sessions: SessionSummary[]) => void;
  onClient: (fp: string, client: RelayClient) => void;
  onClearClient: (fp: string) => void;
}) {
  const { client, relayState } = useRelayMachine(fingerprint);
  const resolvedRef = useRef(false);

  // 把 client 上交父组件（父组件的操作条要拿它提交 Allow/Deny、重查 pendingWaiters）。
  useEffect(() => {
    if (client) onClient(fingerprint, client);
    return () => onClearClient(fingerprint);
  }, [client, fingerprint, onClient, onClearClient]);

  useEffect(() => {
    if (relayState !== "connected" || !client) {
      // 掉线 / 重连中：清掉「本次连接已解析」标记，连回来必须重新解析一次。
      resolvedRef.current = false;
      return;
    }
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    const wanted = new Set(ids);
    client
      .request(MethodSessionList)
      .then((raw) => {
        const res = decodeSessionListResult(raw);
        const matched = res.sessions.filter((s) =>
          wanted.has(String(s.sessionId)),
        );
        onResolved(fingerprint, matched);
      })
      .catch(() => {
        // 解析失败：保持已解析标记，不无谓重试；重连后再试。
      });
  }, [relayState, client, ids, fingerprint, onResolved]);

  return null;
}

// ── 既有 Agent 卡的行 / 目标链（设计稿左栏的 Agent 卡，R19） ─────────────
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
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [follows, setFollows] = useState<FollowItem[]>([]);
  const [resolved, setResolved] = useState<Record<string, SessionSummary[]>>(
    {},
  );
  const [clients, setClients] = useState<Record<string, RelayClient>>({});
  const [waiters, setWaiters] = useState<Record<string, WaiterData>>({});

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

  // 设备 / 关注是锦上添花：各自取不到就保持空，统计卡走诚实空态，不阻塞整页。
  useEffect(() => {
    let alive = true;
    api<{ devices: DeviceItem[] }>("/v1/devices")
      .then((d) => {
        if (alive) setDevices(d.devices);
      })
      .catch(() => {});
    api<{ items: FollowItem[] }>("/v1/follows")
      .then((f) => {
        if (alive) setFollows(f.items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const devicesByFp = useMemo(
    () => new Map((devices ?? []).map((d) => [d.fingerprint, d])),
    [devices],
  );
  const agentsBySync = useMemo(
    () => new Map((agents ?? []).map((a) => [a.sync_id, a])),
    [agents],
  );

  // 设备在线数 = /v1/devices 里在线的机器（agentred）；浏览器（web）自身不算机器。
  const onlineCount = useMemo(
    () => (devices ?? []).filter((d) => d.kind !== "web" && d.online).length,
    [devices],
  );
  const firstOffline = useMemo(
    () => (devices ?? []).find((d) => d.kind !== "web" && !d.online),
    [devices],
  );
  const desktopConnected = useMemo(
    () => (devices ?? []).some((d) => d.kind === "agentred" && d.online),
    [devices],
  );

  // 等待统计与操作条卡：来自关注会话（/v1/follows）+ 中继 session.list 的 waitingForInput。
  const waitingSessions = useMemo<WaitingSessionInfo[]>(() => {
    const out: WaitingSessionInfo[] = [];
    for (const [fp, sessions] of Object.entries(resolved)) {
      for (const s of sessions) {
        if (s.waitingForInput) out.push({ fingerprint: fp, session: s });
      }
    }
    return out;
  }, [resolved]);

  const followedFps = useMemo(
    () => [
      ...new Set(
        follows.filter((f) => !f.invalid).map((f) => f.device_fingerprint),
      ),
    ],
    [follows],
  );

  // 等待数「是否可知」：每条关注都能判定时才显示数字，否则空态（—）。
  //   - 离线机器不可能在等你处理 → 可判定（0）；
  //   - 在线 agentred 机器必须连上中继并解析出会话才可判定；
  //   - 机器查不到 / 非 agentred → 不可判定。
  const waitingKnown = useMemo(() => {
    return followedFps.every((fp) => {
      const dev = devicesByFp.get(fp);
      if (!dev) return false;
      if (dev.kind !== "agentred") return false;
      if (!dev.online) return true;
      return Object.prototype.hasOwnProperty.call(resolved, fp);
    });
  }, [followedFps, devicesByFp, resolved]);

  const waitingCount = waitingKnown ? waitingSessions.length : null;
  const longestWait = useMemo(() => {
    let max = 0;
    for (const { session } of waitingSessions) {
      max = Math.max(max, waitedMinutes(session.updatedAt));
    }
    return max;
  }, [waitingSessions]);

  const onResolved = useCallback((fp: string, sessions: SessionSummary[]) => {
    setResolved((prev) => ({ ...prev, [fp]: sessions }));
  }, []);
  const onClient = useCallback((fp: string, client: RelayClient) => {
    setClients((prev) => ({ ...prev, [fp]: client }));
  }, []);
  const onClearClient = useCallback((fp: string) => {
    setClients((prev) => {
      if (!(fp in prev)) return prev;
      const next = { ...prev };
      delete next[fp];
      return next;
    });
  }, []);

  // 对每条等待会话取中继 pendingWaiters，动作按钮据此渲染（取不到就不渲染该卡）。
  useEffect(() => {
    let alive = true;
    for (const { fingerprint, session } of waitingSessions) {
      const key = waiterKey(fingerprint, session.sessionId);
      if (waiters[key]) continue;
      const client = clients[fingerprint];
      if (!client) continue;
      client
        .request(MethodSessionPendingWaiters, {
          sessionId: session.sessionId,
          ...(session.peerFingerprint
            ? { peerFingerprint: session.peerFingerprint }
            : {}),
        })
        .then((raw) => {
          if (!alive) return;
          const res = decodeSessionPendingWaitersResult(raw);
          setWaiters((prev) => ({
            ...prev,
            [key]: {
              toolPermissions: (res.toolPermissions ??
                []) as PendingToolPermissionShape[],
              askUserQuestions: (res.askUserQuestions ??
                []) as PendingAskQuestionShape[],
            },
          }));
        })
        .catch(() => {
          // 取不到 waiters：该卡不渲染（诚实），下次状态变化再试。
        });
    }
    return () => {
      alive = false;
    };
  }, [waitingSessions, clients, waiters]);

  const actionCards = useMemo<ActionCard[]>(() => {
    return waitingSessions
      .filter(
        ({ fingerprint, session }) =>
          waiters[waiterKey(fingerprint, session.sessionId)],
      )
      .map(({ fingerprint, session }): ActionCard | null => {
        const device = devicesByFp.get(fingerprint);
        if (!device) return null;
        const syncId = session.agentSyncId?.trim() ?? "";
        const agent = agentsBySync.get(syncId);
        return {
          key: `${fingerprint}:${session.sessionId}`,
          fingerprint,
          sessionId: session.sessionId,
          origin: session.peerFingerprint,
          title: sessionTitle(session, t),
          cwd: session.cwd,
          agentName: agent?.name ?? (syncId || device.name),
          waitedAt: session.updatedAt,
          waiters: waiters[waiterKey(fingerprint, session.sessionId)],
          detailPath: `/devices/${device.id}/sessions/${session.sessionId}`,
        };
      })
      .filter((c): c is ActionCard => c !== null)
      .slice(0, 3);
  }, [waitingSessions, waiters, devicesByFp, agentsBySync, t]);

  // Allow / Deny 走真实后端：提交后重查 pendingWaiters，已消失的 waiter 不再渲染。
  async function submitToolDecision(card: ActionCard, allow: boolean) {
    const client = clients[card.fingerprint];
    const waiter = card.waiters.toolPermissions[0];
    if (!client || !waiter?.RequestID) return;
    try {
      await client.request(MethodSubmitToolPermission, {
        sessionId: card.sessionId,
        ...(card.origin ? { peerFingerprint: card.origin } : {}),
        requestId: waiter.RequestID,
        allow,
        alwaysAllowSession: false,
      });
      const raw = await client.request(MethodSessionPendingWaiters, {
        sessionId: card.sessionId,
        ...(card.origin ? { peerFingerprint: card.origin } : {}),
      });
      const res = decodeSessionPendingWaitersResult(raw);
      setWaiters((prev) => ({
        ...prev,
        [card.sessionId]: {
          toolPermissions: (res.toolPermissions ??
            []) as PendingToolPermissionShape[],
          askUserQuestions: (res.askUserQuestions ??
            []) as PendingAskQuestionShape[],
        },
      }));
    } catch {
      // 提交失败保持原样，不假装成功。
    }
  }

  const resolvers = devices
    ? [...devicesByFp.values()]
        .filter(
          (d) =>
            d.kind === "agentred" &&
            d.online &&
            follows.some(
              (f) => f.device_fingerprint === d.fingerprint && !f.invalid,
            ),
        )
        .map((d) => (
          <MachineResolver
            key={d.fingerprint}
            fingerprint={d.fingerprint}
            ids={follows
              .filter(
                (f) => f.device_fingerprint === d.fingerprint && !f.invalid,
              )
              .map((f) => f.session_id)}
            onResolved={onResolved}
            onClient={onClient}
            onClearClient={onClearClient}
          />
        ))
    : [];

  return (
    <AppShell
      title={t("nav.overview")}
      right={<Fresh connected={desktopConnected} />}
    >
      <div className="mx-auto w-full max-w-[1200px] space-y-4">
        {loadError !== null && (
          <Alert variant="destructive">{loadErrorText(loadError, t)}</Alert>
        )}

        {/* 4 统计卡（共享 Metric；今日用量 / 异常无数据源 → 诚实空态 —，不编数字） */}
        <div
          data-testid="overview-tiles"
          className="grid grid-cols-2 gap-3 md:grid-cols-4"
        >
          <Metric
            testId="tile-online"
            label={t("overview.tiles.online")}
            value={devices === null ? NO_DATA : String(onlineCount)}
            unit={
              devices === null
                ? undefined
                : `/ ${devices.filter((d) => d.kind !== "web").length}`
            }
            sub={
              firstOffline
                ? t("overview.tiles.onlineSub", { device: firstOffline.name })
                : null
            }
            icon={Monitor}
          />
          <Metric
            testId="tile-waiting"
            label={t("overview.tiles.waiting")}
            value={waitingCount === null ? NO_DATA : String(waitingCount)}
            sub={
              longestWait > 0
                ? t("overview.tiles.waitingSub", { minutes: longestWait })
                : null
            }
            icon={Clock3}
          />
          <Metric
            testId="tile-usage"
            label={t("overview.tiles.usage")}
            value={NO_DATA}
            icon={Gauge}
          />
          <Metric
            testId="tile-errors"
            tone="danger"
            label={t("overview.tiles.errors")}
            value={NO_DATA}
            icon={AlertTriangle}
          />
        </div>

        {/* 琥珀「等你处理」操作条：无等待会话（或连不到）时整条不渲染。 */}
        <ActionStrip
          cards={actionCards}
          onAllow={(c) => submitToolDecision(c, true)}
          onDeny={(c) => submitToolDecision(c, false)}
        />

        {/* 双栏：左 Agent 卡 + 最近授权与变更 | 右 340px 本月用量 + 安全与审计 */}
        <div
          data-testid="overview-cols"
          className="flex flex-col gap-4 lg:flex-row"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="overflow-hidden rounded-lg border border-border bg-card py-0">
              <div className="flex flex-row items-center gap-2 border-b border-border px-4 py-3">
                {/* 页级 h1（保留既有语义）：Agent 卡是左栏主内容，标题用 overview.title。 */}
                <h1 className="text-sm font-bold text-foreground">
                  {t("overview.title")}
                </h1>
                {agents !== null && (
                  <span className="text-xs text-subtle-foreground">
                    {t("overview.subtitle", { count: agents.length })}
                  </span>
                )}
              </div>
              {loading ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  {t("common.loading")}
                </p>
              ) : loadError !== null &&
                (agents?.length ?? 0) === 0 ? null : (agents?.length ?? 0) ===
                0 ? (
                <EmptyState
                  testId="empty-agents"
                  icon={Bot}
                  title={t("overview.empty")}
                />
              ) : (
                <div className="divide-y divide-border">
                  {agents?.map((agent) => (
                    <AgentRow key={agent.sync_id} agent={agent} t={t} />
                  ))}
                </div>
              )}
            </div>

            {/* 最近授权与变更：无审计数据源 → 共享诚实空态（不编事件/IP/时间）。 */}
            <div className="rounded-lg border border-border bg-card">
              <EmptyState
                testId="empty-recent-auth"
                icon={ScrollText}
                title={t("overview.recentAuth.title")}
                action={
                  <Link
                    to="/audit"
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {t("overview.recentAuth.all")}
                  </Link>
                }
              />
            </div>
          </div>

          <aside
            data-testid="overview-aside"
            className="flex w-full shrink-0 flex-col gap-4 lg:w-[340px]"
          >
            {/* 本月用量：无数据源 → 共享诚实空态；用量页尚不存在，不造死链。 */}
            <div className="rounded-lg border border-border bg-card">
              <EmptyState
                testId="empty-usage"
                icon={Gauge}
                title={t("overview.usage.title")}
              />
            </div>

            {/* 安全与审计：无数据源 → 共享诚实空态（不编令牌数/登录 IP）。 */}
            <div className="rounded-lg border border-border bg-card">
              <EmptyState
                testId="empty-security"
                icon={ShieldCheck}
                title={t("overview.security.title")}
                action={
                  <Link
                    to="/audit"
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {t("overview.security.all")}
                  </Link>
                }
              />
            </div>
          </aside>
        </div>

        {/* 每个在线且有非失效关注的 agentred 机器挂一个中继解析器。 */}
        {resolvers}
      </div>
    </AppShell>
  );
}
