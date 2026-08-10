import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/wire";

/**
 * R5 会话列表（桌面）：按 Agent 分组。每条显示对话标题、运行状态、是否正在等待
 * 输入；Agent 名称与头像经块 1 的同步标识（agentSyncId）解析。R7 未到达的老会话
 * 既没有标题也没有 Agent 标识 → 归入「未命名」分组，如实退化为
 * 「工作目录 · 后端 · 状态」，不猜、不填占位名（mockup 帧 46）。
 *
 * 可访问性：运行状态 / 等待输入都以文字呈现，不只靠颜色。
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
}

interface Group {
  key: string;
  label: string;
  avatarColor?: string;
  sessions: SessionSummary[];
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

function SessionRow({
  session,
  sessionPath,
  t,
}: {
  session: SessionSummary;
  sessionPath: (id: number) => string;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const title = sessionTitle(session, t);
  const hasRealTitle = !!session.title?.trim();
  const waiting = !!session.waitingForInput;
  return (
    <Link
      to={sessionPath(session.sessionId)}
      className="flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        {/* 只有真标题才加副行:老会话退化时标题本身就是「工作目录 · 后端 · 状态」,
            副行再印一遍就是重复。 */}
        {hasRealTitle && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t("session.list.legacy", {
              cwd: session.cwd?.trim() ? session.cwd : "—",
              backend: session.backendType?.trim() ? session.backendType : "—",
              status: lifecycleLabel(session.lifecycleState, t),
            })}
          </p>
        )}
      </div>
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
    </Link>
  );
}

export default function SessionList({
  sessions,
  agents,
  sessionPath,
}: SessionListProps) {
  const { t } = useTranslation();
  const groups = useMemo(
    () => buildGroups(sessions, agents, t),
    [sessions, agents, t],
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
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-primary"
              style={
                group.avatarColor
                  ? { backgroundColor: group.avatarColor }
                  : undefined
              }
            />
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
                />
              ))}
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}
