import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bookmark } from "lucide-react";

import { useIsMobile } from "@/components/use-is-mobile";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatRelativeTime, statusDotClass } from "@/lib/sessionView";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/wire";

/**
 * R5 会话列表：桌面按 Agent 分组，移动按状态分组（决策 12）。
 *
 * 桌面：按 Agent 分组，每条显示对话标题、运行状态、是否正在等待输入；Agent 名称
 * 与头像经块 1 的同步标识（agentSyncId）解析。R7 未到达的老会话既没有标题也没有
 * Agent 标识 → 归入「未命名」分组，如实退化为「工作目录 · 后端 · 状态」。
 *
 * 移动：按状态分组（等你处理置顶 → 运行中 → 已中断 → 其余），不按 Agent。
 * 可访问性：运行状态 / 等待输入都以文字呈现，不只靠颜色；触控目标行高 ≥ 44px。
 */
export interface SessionAgent {
  sync_id: string;
  name: string;
  avatar_color?: string;
}

interface SessionListProps {
  sessions: SessionSummary[];
  agents: SessionAgent[];
  /** 点击某条会话时的目标路径模板；{{sessionId}} 会被替换。 */
  sessionPath: (sessionId: number) => string;
  /** 已在账号级关注名单里的会话（R12）。 */
  followedSessionIds?: Set<number>;
  /**
   * 关注 / 取消关注一条会话（R12）。桌面把开关放在列表行尾（帧 45a）；不传即不渲染
   * 开关，供不需要关注入口的复用场景使用。移动端的入口在详情页顶栏（决策 16），
   * 因此这里在移动形态下同样不渲染。
   */
  onToggleFollow?: (sessionId: number) => void;
  /**
   * 本页所属的设备名（T6 两行行的 Row2 = 设备 · 后端）。调用方（设备页）知道自己在
   * 哪台机器上；不传就不编造，Row2 只剩后端。
   */
  deviceName?: string;
}

interface Group {
  key: string;
  label: string;
  avatarColor?: string;
  sessions: SessionSummary[];
}

/** 移动按状态分组的组键；顺序即展示顺序（决策 12：等你处理置顶）。 */
export type StatusGroupKey = "waiting" | "running" | "interrupted" | "others";

/**
 * 一条会话归入哪个状态组。
 * 「正在等待输入」是运行之上的实时叠加，永远优先归入「等你处理」；
 * 其余按生命周期：running → 运行中、interrupted → 已中断；
 * idle 与未知旧状态如实归入「其余」，不猜。
 */
export function statusGroupKey(s: SessionSummary): StatusGroupKey {
  if (s.waitingForInput) return "waiting";
  switch (s.lifecycleState) {
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    default:
      return "others";
  }
}

/** 移动按状态分组的展示顺序（决策 12：等你处理置顶）。 */
export const STATUS_GROUP_ORDER: StatusGroupKey[] = [
  "waiting",
  "running",
  "interrupted",
  "others",
];

export function buildStatusGroups(
  sessions: SessionSummary[],
  t: (k: string) => string,
): Group[] {
  const byKey = new Map<StatusGroupKey, Group>();
  for (const s of sessions) {
    const key = statusGroupKey(s);
    const group = byKey.get(key) ?? {
      key,
      label: t(`session.list.group.${key}`),
      sessions: [],
    };
    group.sessions.push(s);
    byKey.set(key, group);
  }
  return STATUS_GROUP_ORDER.filter((k) => byKey.has(k)).map((k) =>
    byKey.get(k)!,
  );
}

function lifecycleLabel(state: string, t: (k: string) => string): string {
  switch (state) {
    case "running":
      return t("session.list.running");
    case "idle":
      return t("session.list.idle");
    case "interrupted":
      return t("session.list.interrupted");
    default:
      // 不认识的旧状态如实显示原文，不猜。
      return state;
  }
}

/** R7 未到达的老会话的退化标题：「工作目录 · 后端 · 状态」。 */
export function degradedTitle(
  s: SessionSummary,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  return t("session.list.legacy", {
    cwd: s.cwd?.trim() ? s.cwd : "—",
    backend: s.backendType?.trim() ? s.backendType : "—",
    status: lifecycleLabel(s.lifecycleState, t),
  });
}

export function sessionTitle(
  s: SessionSummary,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  return s.title?.trim() ? s.title : degradedTitle(s, t);
}

function buildGroups(
  sessions: SessionSummary[],
  agents: SessionAgent[],
  t: (k: string) => string,
): Group[] {
  const bySyncId = new Map(agents.map((a) => [a.sync_id, a]));
  const groups = new Map<string, Group>();
  for (const s of sessions) {
    const syncId = s.agentSyncId?.trim() ?? "";
    let key: string;
    let label: string;
    let avatarColor: string | undefined;
    if (syncId) {
      const agent = bySyncId.get(syncId);
      key = syncId;
      label = agent?.name ?? syncId; // 同步标识解析不到名字时如实显示标识，不猜。
      avatarColor = agent?.avatar_color;
    } else {
      key = "__unnamed__";
      label = t("session.list.unnamedGroup");
    }
    const group = groups.get(key) ?? {
      key,
      label,
      avatarColor,
      sessions: [],
    };
    group.sessions.push(s);
    groups.set(key, group);
  }
  const out = [...groups.values()];
  out.sort((a, b) => {
    if (a.key === "__unnamed__") return 1;
    if (b.key === "__unnamed__") return -1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

/**
 * R5 的「最后活动时间」。只在 daemon 报了 updated_at 时渲染 —— 老会话缺这一列时
 * 什么都不显示，不猜一个时刻（与退化标题同一条原则）。
 */
export function LastActive({
  ms,
  locale,
}: {
  ms: number | undefined;
  locale: string;
}) {
  if (!ms) return null;
  const at = new Date(ms);
  return (
    <time
      dateTime={at.toISOString()}
      title={at.toLocaleString()}
      className="shrink-0 text-xs text-subtle-foreground"
    >
      {formatRelativeTime(ms, locale)}
    </time>
  );
}

/**
 * 行首状态点（T6 两行行 Row1）。颜色走 statusDotClass，深/浅都从 token 来；
 * 状态以 aria-label 呈现（不只靠颜色），移动端另有文字徽标兜底。
 */
export function StatusDot({
  state,
  testid,
  label,
}: {
  state: { lifecycleState: string; waitingForInput?: boolean };
  testid: string;
  label: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid={testid}
      className={cn("size-2 shrink-0 rounded-full", statusDotClass(state))}
    />
  );
}

function SessionRow({
  session,
  sessionPath,
  t,
  locale,
  isMobile,
  agent,
  followed,
  onToggleFollow,
  deviceName,
}: {
  session: SessionSummary;
  sessionPath: (id: number) => string;
  t: (k: string, opts?: Record<string, unknown>) => string;
  locale: string;
  isMobile: boolean;
  agent?: SessionAgent;
  followed: boolean;
  onToggleFollow?: (sessionId: number) => void;
  deviceName?: string;
}) {
  const title = sessionTitle(session, t);
  const hasRealTitle = !!session.title?.trim();
  const waiting = !!session.waitingForInput;
  const dotLabel = waiting
    ? t("session.list.waiting")
    : lifecycleLabel(session.lifecycleState, t);
  const hasRow2 =
    hasRealTitle && (deviceName?.trim() || session.backendType?.trim());
  // Row2 的正文：「设备 · 后端」（设备名可选，不传就只剩后端）。拼成一个文本节点——
  // 第二行是一条整体的小字，不是三段高亮。
  const row2 = [deviceName?.trim(), session.backendType?.trim()]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      data-testid={`session-row-${session.sessionId}`}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent",
        // 触控目标：移动行高不小于 44px。
        isMobile && "min-h-11 py-3",
      )}
    >
      <Link
        to={sessionPath(session.sessionId)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3",
          // 触控目标是可点的那个元素本身，不只是包着它的行。
          isMobile && "min-h-11",
        )}
      >
        <div className="min-w-0 flex-1">
          {/* R5：Agent 的名称与头像。桌面的分组维度就是 Agent（名称与头像在分组
              标题上），移动按状态分组，因此落在行上（设计稿 48b / 屏 20）。解析不
              出同步标识时什么都不渲染——不猜、不填占位名。 */}
          {isMobile && agent && (
            <p className="flex items-center gap-1.5 truncate text-xs font-medium text-muted-foreground">
              {agent.avatar_color && (
                <span
                  data-testid={`session-row-avatar-${session.sessionId}`}
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: agent.avatar_color }}
                />
              )}
              {agent.name}
            </p>
          )}
          {/* Row1（T6）：状态点 + 标题 + 相对时间。 */}
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <StatusDot
              state={session}
              testid={`session-dot-${session.sessionId}`}
              label={dotLabel}
            />
            <span className="truncate">{title}</span>
            <LastActive ms={session.updatedAt} locale={locale} />
          </p>
          {/* Row2（T6）：设备 · 后端。只有真标题才加副行：老会话退化时标题本身就是
              「工作目录 · 后端 · 状态」，副行再印一遍就是重复。设备名可选——不传
              就不编造，Row2 只剩后端。 */}
          {hasRow2 && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {row2}
            </p>
          )}
        </div>
        {/* 移动端保文字徽标（可访问性：不只靠颜色）；桌面由状态点 + aria 承担。 */}
        {isMobile && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium",
              waiting
                ? "bg-status-waiting-bg text-status-waiting"
                : "bg-muted text-muted-foreground",
            )}
          >
            {waiting
              ? t("session.list.waiting")
              : lifecycleLabel(session.lifecycleState, t)}
          </span>
        )}
      </Link>
      {/* R12：桌面的关注开关在行尾（帧 45a）；移动端在详情页顶栏（决策 16）。 */}
      {!isMobile && onToggleFollow && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t(followed ? "chat.unfollow" : "chat.follow")}
          title={t(followed ? "chat.unfollow" : "chat.follow")}
          aria-pressed={followed}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onToggleFollow(session.sessionId)}
        >
          <Bookmark
            className="size-3.5"
            fill={followed ? "currentColor" : "none"}
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );
}

export default function SessionList({
  sessions,
  agents,
  sessionPath,
  followedSessionIds,
  onToggleFollow,
  deviceName,
}: SessionListProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const groups = useMemo(
    () =>
      isMobile
        ? buildStatusGroups(sessions, t)
        : buildGroups(sessions, agents, t),
    [sessions, agents, t, isMobile],
  );
  const agentBySyncID = useMemo(
    () => new Map(agents.map((a) => [a.sync_id, a])),
    [agents],
  );

  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground">
          {t("session.list.empty")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            {group.avatarColor && (
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: group.avatarColor }}
              />
            )}
            {group.label}
            <span className="text-xs font-normal text-subtle-foreground">
              {group.sessions.length}
            </span>
          </h2>
          <Card className="py-1">
            <CardContent className="p-1">
              {group.sessions.map((s) => (
                <SessionRow
                  key={s.sessionId}
                  session={s}
                  sessionPath={sessionPath}
                  t={t}
                  locale={i18n.language}
                  isMobile={isMobile}
                  agent={agentBySyncID.get(s.agentSyncId?.trim() ?? "")}
                  followed={!!followedSessionIds?.has(s.sessionId)}
                  onToggleFollow={onToggleFollow}
                  deviceName={deviceName}
                />
              ))}
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}
