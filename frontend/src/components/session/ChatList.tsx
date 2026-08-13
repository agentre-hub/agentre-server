import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bookmark } from "lucide-react";

import {
  sessionTitle,
  statusGroupKey,
  StatusDot,
  STATUS_GROUP_ORDER,
  type StatusGroupKey,
} from "@/components/session/SessionList";
import { useIsMobile } from "@/components/use-is-mobile";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  formatRelativeTime,
  matchesRowSearch,
  matchesSessionFilter,
  recentTimestamp,
  takeRecent,
  unreadCount,
  type SessionFilter,
} from "@/lib/sessionView";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/wire";

/**
 * 「对话」页的列表（R13，mockup 帧 49 / 49b）：骨架是账号下的 Agent 列表，因此
 * 任何时候都有内容。
 *
 * 桌面（T6，p5Orc「优化」）：
 *   - 顶部「最近 · 跨 Agent」扁平区：跨全部 Agent 取最近 5 条（按 updatedAt /
 *     followedAt 之新），与分组内的行共用同一套两行行。
 *   - 筛选 chips：全部 / 运行中 / 未读 N。运行中 = 正在运行且不等待输入；未读 =
 *     正在等输入；「最近」区随筛选一起过滤。
 *   - ↑↓ 键盘导航：焦点落在列表容器时移动「选中」高亮，Enter 打开选中行。
 *   - 行上右键：只放有真实后端的动作——新标签打开 / 取消关注 / 移除失效；
 *     改名 / 删除没有后端支持，一律省略，不伪造。
 *
 * 两行行（Row1 状态点 + 标题 + 相对时间；Row2 设备 · 后端）：设备名来自关注名单
 * 解析出的设备（/v1/devices），后端来自 session.list；老会话退化时标题本身就是
 * 「工作目录 · 后端 · 状态」，副行不重复印。
 *
 * 移动按状态分组（决策 12，屏 20）：等你处理置顶 → 运行中 → 已中断 → 其余；
 * 关注入口不在列表行、移到详情页顶栏（决策 16），因此移动行不渲染关注开关；
 * 移动行保文字徽标（不只靠颜色），触控目标 ≥ 44px。空态由页面在屏 32 形态呈现，
 * 本组件不重复。
 *
 * 失效（目标设备被撤销 / 目标会话在机器上已不存在）的条目单列一节，可一键移除。
 * 机器离线时该条仍在名单里并标明离线（R13），不消失。
 */
export interface ChatSessionRow {
  key: string;
  fingerprint: string;
  sessionId: number;
  deviceId: number;
  deviceName: string;
  followedAt: number;
  summary: SessionSummary;
  /** 桌面副本不在场而退到 agentred 副本时，只读得到执行端保留的部分历史。 */
  historyIncomplete?: boolean;
  /** 移动形态下钉在行上的 Agent 名称与头像色（R13，见 regroupByStatus）。 */
  agentName?: string;
  agentColor?: string;
}

export interface ChatGroup {
  key: string;
  label: string;
  avatarColor?: string;
  sessions: ChatSessionRow[];
}

export interface ChatOfflineRow {
  key: string;
  fingerprint: string;
  sessionId: number;
  deviceId: number;
  deviceName: string;
  deviceKind: string;
  lastSeenAt: number;
}

export interface ChatPendingRow {
  key: string;
  deviceName: string;
}

export interface ChatInvalidRow {
  key: string;
  fingerprint: string;
  sessionId: number;
  deviceName: string | null;
  /** device = 目标设备被撤销 / 不存在；session = 机器上已没有这条会话。 */
  reason: "device" | "session";
}

interface ChatListProps {
  groups: ChatGroup[];
  /** 在线但还没解析出来（连接中）的会话所在机器。 */
  pending: ChatPendingRow[];
  offline: ChatOfflineRow[];
  invalid: ChatInvalidRow[];
  onUnfollow: (fingerprint: string, sessionId: number) => void;
  onRemoveInvalid: (fingerprint: string, sessionId: number) => void;
  sessionPath: (deviceId: number, sessionId: number) => string;
  /** 桌面搜索词（非空时真实过滤会话行；移动无搜索框，恒空）。 */
  searchQuery?: string;
  /** 桌面点击 / Enter 选中一条真实会话 → 右栏嵌入详情；移动不传（行仍走路由跳转）。 */
  onSelect?: (deviceId: number, sessionId: number) => void;
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/** T6 筛选 chips 的取值顺序（全部 → 运行中 → 未读）。 */
const FILTER_CHIPS: SessionFilter[] = ["all", "running", "unread"];

/**
 * 把（桌面的）Agent 分组拍平后按状态重组（决策 12 的移动形态）。
 *
 * R13：「移动的列表行本身就以 Agent 命名」——分组标题这时是状态，Agent 的名称与
 * 头像因此要跟着行走（屏 20 的 ChatItem 第一行就是 Agent 名）。拍平时把它所属分组
 * 的名称与头像色钉在行上，行渲染时直接用。
 */
function regroupByStatus(
  groups: ChatGroup[],
  t: (k: string, opts?: Record<string, unknown>) => string,
): ChatGroup[] {
  const byKey = new Map<StatusGroupKey, ChatGroup>();
  for (const g of groups) {
    for (const row of g.sessions) {
      const key = statusGroupKey(row.summary);
      const group = byKey.get(key) ?? {
        key,
        label: t(`session.list.group.${key}`),
        sessions: [],
      };
      group.sessions.push(
        // 「未命名」分组（R7 未到达的老会话）不冒充 Agent 名：不猜、不填占位名。
        g.key === "__unnamed__"
          ? row
          : { ...row, agentName: g.label, agentColor: g.avatarColor },
      );
      byKey.set(key, group);
    }
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

/**
 * 会话行的正文（两行行）：Row1 = 状态点 + 标题 + 相对时间；Row2 = 设备 · 后端。
 * 桌面由状态点 + aria 承担状态（不只靠颜色）；移动保文字徽标 + Agent 名行。
 * 包在 Link（移动）或 select 按钮（桌面）里，两者共用同一份正文。
 */
function SessionRowBody({
  row,
  title,
  hasRow2,
  row2,
  dotLabel,
  waiting,
  isMobile,
  t,
  locale,
  testidPrefix,
}: {
  row: ChatSessionRow;
  title: string;
  hasRow2: boolean;
  row2: string;
  dotLabel: string;
  waiting: boolean;
  isMobile: boolean;
  t: (k: string, opts?: Record<string, unknown>) => string;
  locale: string;
  testidPrefix: string;
}) {
  return (
    <>
      <div className="min-w-0 flex-1">
        {/* R13：移动的列表行本身就以 Agent 命名（屏 20）；桌面的分组维度已经是
            Agent，行上不再重复。 */}
        {isMobile && row.agentName && (
          <p className="flex items-center gap-1.5 truncate text-xs font-medium text-muted-foreground">
            {row.agentColor && (
              <span
                data-testid={`${testidPrefix}-avatar-${row.sessionId}`}
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.agentColor }}
              />
            )}
            {row.agentName}
          </p>
        )}
        {/* Row1：状态点 + 标题 + 相对时间（最后活动时间，R5 与行上是同一套信息）。 */}
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <StatusDot
            state={row.summary}
            testid={`${testidPrefix}-dot-${row.sessionId}`}
            label={dotLabel}
          />
          <span className="truncate">{title}</span>
          {row.summary.updatedAt ? (
            <time
              dateTime={new Date(row.summary.updatedAt).toISOString()}
              title={new Date(row.summary.updatedAt).toLocaleString()}
              className="shrink-0 text-xs font-normal text-subtle-foreground"
            >
              {formatRelativeTime(row.summary.updatedAt, locale)}
            </time>
          ) : null}
        </p>
        {/* Row2：设备 · 后端。老会话退化时标题本身就是上下文，副行不重复印。 */}
        {hasRow2 && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {row2}
          </p>
        )}
        {row.historyIncomplete && (
          <p className="mt-0.5 text-xs text-status-waiting">
            {t("session.list.historyIncomplete")}
          </p>
        )}
      </div>
      {/* 移动端保文字徽标（不只靠颜色）；桌面由状态点 + aria 承担。 */}
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
            : lifecycleLabel(row.summary.lifecycleState, t)}
        </span>
      )}
    </>
  );
}

/**
 * 会话行（T6 两行行）。Row1 = 状态点 + 标题 + 相对时间；Row2 = 设备 · 后端。
 * 桌面由状态点 + aria 承担状态（不只靠颜色）；移动保文字徽标 + Agent 名行。
 * `showFollow` 只在桌面分组行开——「最近」区不重复放关注开关。
 * 桌面（任务 6）：点行 = 选中 → 右栏嵌入详情；移动仍走路由跳转。
 */
function SessionRow({
  row,
  onUnfollow,
  sessionPath,
  t,
  locale,
  isMobile,
  showFollow,
  selected,
  onMenu,
  onSelect,
  testidPrefix,
}: {
  row: ChatSessionRow;
  onUnfollow: (fp: string, sid: number) => void;
  sessionPath: (deviceId: number, sessionId: number) => string;
  t: (k: string, opts?: Record<string, unknown>) => string;
  locale: string;
  isMobile: boolean;
  showFollow: boolean;
  selected: boolean;
  onMenu: (e: React.MouseEvent, path: string) => void;
  onSelect: () => void;
  testidPrefix: string;
}) {
  const waiting = !!row.summary.waitingForInput;
  const title = sessionTitle(row.summary, t);
  const hasRealTitle = !!row.summary.title?.trim();
  const dotLabel = waiting
    ? t("session.list.waiting")
    : lifecycleLabel(row.summary.lifecycleState, t);
  const hasRow2 = !!(
    hasRealTitle &&
    (row.deviceName?.trim() || row.summary.backendType?.trim())
  );
  // Row2 的正文：「设备 · 后端」。拼成一个文本节点——第二行是一条整体的小字。
  const row2 = [row.deviceName?.trim(), row.summary.backendType?.trim()]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent",
        // 触控目标：移动行高不小于 44px。
        isMobile && "min-h-11 py-3",
        // T6：↑↓ 键盘导航的「选中」高亮。
        selected && "bg-primary-soft/40",
      )}
      data-nav-target={row.key}
      aria-current={selected ? "true" : undefined}
      onContextMenu={(e) => onMenu(e, sessionPath(row.deviceId, row.sessionId))}
    >
      {/* 桌面（任务 6）：点行 = 选中 → 右栏嵌入详情，不导航离开（preventDefault）；
          移动仍走路由详情页。href 保持真实详情路由，右键/新标签打开仍是详情页。 */}
      <Link
        to={sessionPath(row.deviceId, row.sessionId)}
        className="flex min-w-0 flex-1 items-center gap-3"
        onClick={
          isMobile
            ? undefined
            : (e) => {
                e.preventDefault();
                onSelect();
              }
        }
      >
        <SessionRowBody
          row={row}
          title={title}
          hasRow2={hasRow2}
          row2={row2}
          dotLabel={dotLabel}
          waiting={waiting}
          isMobile={isMobile}
          t={t}
          locale={locale}
          testidPrefix={testidPrefix}
        />
      </Link>
      {/* 决策 16：关注入口桌面在列表行、移动在详情页顶栏——移动不渲染行内开关。
          「最近」区不重复放开关（showFollow=false）。 */}
      {!isMobile && showFollow && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("chat.unfollow")}
          title={t("chat.unfollow")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onUnfollow(row.fingerprint, row.sessionId);
          }}
        >
          <Bookmark
            className="size-3.5"
            fill="currentColor"
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );
}

function OfflineRow({
  row,
  onUnfollow,
  sessionPath,
  t,
  isMobile,
  selected,
  onMenu,
  onSelect,
}: {
  row: ChatOfflineRow;
  onUnfollow: (fp: string, sid: number) => void;
  sessionPath: (deviceId: number, sessionId: number) => string;
  t: (k: string, opts?: Record<string, unknown>) => string;
  isMobile: boolean;
  selected: boolean;
  onMenu: (e: React.MouseEvent, path: string) => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent",
        isMobile && "min-h-11 py-3",
        selected && "bg-primary-soft/40",
      )}
      data-nav-target={row.key}
      aria-current={selected ? "true" : undefined}
      onContextMenu={(e) => onMenu(e, sessionPath(row.deviceId, row.sessionId))}
    >
      {/* 桌面：离线行也可选中 → 右栏嵌入（详情会如实显示机器离线状态）；移动走路由。 */}
      <Link
        to={sessionPath(row.deviceId, row.sessionId)}
        className="min-w-0 flex-1"
        onClick={
          isMobile
            ? undefined
            : (e) => {
                e.preventDefault();
                onSelect();
              }
        }
      >
        <p className="truncate text-sm font-medium text-foreground">
          {t(
            row.deviceKind === "desktop"
              ? "chat.desktopAppNotRunningWithTime"
              : "chat.offlineMachineWithTime",
            {
              machine: row.deviceName,
              time: formatTime(row.lastSeenAt),
            },
          )}
        </p>
      </Link>
      {/* 决策 16：移动的关注入口在详情页顶栏，不在列表行。 */}
      {!isMobile && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("chat.unfollow")}
          title={t("chat.unfollow")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onUnfollow(row.fingerprint, row.sessionId);
          }}
        >
          <Bookmark
            className="size-3.5"
            fill="currentColor"
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );
}

function InvalidRow({
  row,
  onRemove,
  t,
  onMenu,
}: {
  row: ChatInvalidRow;
  onRemove: (fp: string, sid: number) => void;
  t: (k: string) => string;
  onMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-md px-3 py-2.5"
      onContextMenu={onMenu}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-muted-foreground">
          {row.deviceName ?? t("chat.noMachine")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("chat.invalidBody")}
        </p>
      </div>
      <Button
        variant="outline"
        size="xs"
        onClick={() => onRemove(row.fingerprint, row.sessionId)}
      >
        {t("chat.remove")}
      </Button>
    </div>
  );
}

/** T6 右键菜单的目标。kind 决定放哪些动作。 */
interface MenuTarget {
  x: number;
  y: number;
  kind: "session" | "offline" | "invalid";
  fingerprint: string;
  sessionId: number;
  path?: string;
}

/**
 * T6 行上右键菜单：只放有真实后端的动作——新标签打开 / 取消关注 / 移除失效；
 * 改名 / 删除没有后端支持，一律省略，不伪造。
 */
function RowContextMenu({
  menu,
  onAction,
  onClose,
  t,
}: {
  menu: MenuTarget;
  onAction: (
    kind: MenuTarget["kind"],
    fp: string,
    sid: number,
    path: string | undefined,
    item: string,
  ) => void;
  onClose: () => void;
  t: (k: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // 点在菜单内部不关（否则 mousedown 会先于 click 把它关掉）。
      if (
        ref.current &&
        e.target instanceof Node &&
        ref.current.contains(e.target)
      )
        return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // 打开 / 换目标时把焦点送进菜单：aria 菜单模式要求键盘/读屏用户不用再 Tab 一圈。
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  // 菜单内的 ↑↓/Home/End 在项间移动焦点，Escape 关闭；stopPropagation 防止
  // 事件漏给列表容器的 ↑↓ 选中逻辑（菜单和列表是同一个键盘祖先）。
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ??
        [],
    );
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (items.length === 0) return;
    let idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (idx === -1) idx = e.key === "ArrowDown" ? -1 : items.length;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      items[(idx + dir + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      items[items.length - 1]?.focus();
    }
  };

  const items =
    menu.kind === "invalid"
      ? [{ key: "remove", label: t("session.ux.menu.removeInvalid") }]
      : [
          { key: "open", label: t("session.ux.menu.openNewTab") },
          { key: "unfollow", label: t("session.ux.menu.unfollow") },
        ];
  const x = Math.min(menu.x, window.innerWidth - 176);
  const y = Math.min(menu.y, window.innerHeight - items.length * 32 - 16);
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="row-context-menu"
      className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-overlay"
      style={{ top: Math.max(0, y), left: Math.max(0, x) }}
      onKeyDown={handleKeyDown}
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-popover-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() =>
            onAction(
              menu.kind,
              menu.fingerprint,
              menu.sessionId,
              menu.path,
              it.key,
            )
          }
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export default function ChatList({
  groups,
  pending,
  offline,
  invalid,
  onUnfollow,
  onRemoveInvalid,
  sessionPath,
  searchQuery = "",
  onSelect,
}: ChatListProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  // T6 桌面形态：筛选 chips + 最近区 + 键盘选中 + 右键菜单。全部只属于桌面。
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  // ↑↓ 键盘导航的目标行都在这个容器里；移动选中后把该行滚进视口。
  const containerRef = useRef<HTMLDivElement>(null);

  // 决策 12：桌面按 Agent 分组、移动按状态分组。
  const rendered = isMobile ? regroupByStatus(groups, t) : groups;

  // 未读（等待输入）总数，喂「未读 N」chip 的计数。与当前筛选无关。
  const unread = useMemo(
    () =>
      groups.reduce(
        (n, g) => n + unreadCount(g.sessions.map((s) => s.summary)),
        0,
      ),
    [groups],
  );

  // 桌面：筛选 + 搜索后的分组行。「最近」区随之一过滤，保持一致性。
  // 搜索是真实行为：按标题 / cwd / 后端 / 设备名 / Agent 名匹配本页会话行，
  // 空查询不过滤。移动（屏 20 头部搜索）同样过滤，不区分形态。
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim();
    let groups = rendered;
    if (!isMobile && filter !== "all") {
      groups = groups
        .map((g) => ({
          ...g,
          sessions: g.sessions.filter((s) =>
            matchesSessionFilter(s.summary, filter),
          ),
        }))
        .filter((g) => g.sessions.length > 0);
    }
    if (q) {
      groups = groups
        .map((g) => ({
          ...g,
          sessions: g.sessions.filter((s) =>
            matchesRowSearch(
              [
                s.summary.title,
                s.summary.cwd,
                s.summary.backendType,
                s.deviceName,
                g.label,
              ],
              q,
            ),
          ),
        }))
        .filter((g) => g.sessions.length > 0);
    }
    return groups;
  }, [rendered, filter, isMobile, searchQuery]);

  // 搜索同样作用于离线机器行（按设备名匹配），桌面与移动一致。
  const visibleOffline = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return offline;
    return offline.filter((o) => matchesRowSearch([o.deviceName], q));
  }, [offline, searchQuery]);

  // 桌面：最近 · 跨 Agent（跨全部 Agent 取最近 5 条）。排序键 = updatedAt /
  // followedAt 之新（recentTimestamp）。
  const recentRows = useMemo(() => {
    if (isMobile) return [];
    const rows = filteredGroups
      .flatMap((g) => g.sessions)
      .map((row) => ({
        ...row,
        recent: recentTimestamp(row.summary.updatedAt, row.followedAt),
      }));
    return takeRecent(rows, 5);
  }, [filteredGroups, isMobile]);

  // ↑↓ 键盘导航的有序目标：最近区 + 各分组行 + 离线（失效没有目的地，不进导航）。
  // 「最近」区的行与所属分组里的行是同一批会话（同 key）——必须去重，否则选中
  // 一个键时「最近」区与分组里那一行会同亮，Enter 也落在重复目标上。保留最近区
  // 的首次出现（导航从它开始），分组里的同名行不再重复进列表。
  const navTargets = useMemo(() => {
    if (isMobile) return [];
    const seen = new Set<string>();
    const out: {
      key: string;
      path: string;
      deviceId: number;
      sessionId: number;
    }[] = [];
    for (const r of recentRows) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      out.push({
        key: r.key,
        path: sessionPath(r.deviceId, r.sessionId),
        deviceId: r.deviceId,
        sessionId: r.sessionId,
      });
    }
    for (const g of filteredGroups)
      for (const s of g.sessions) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        out.push({
          key: s.key,
          path: sessionPath(s.deviceId, s.sessionId),
          deviceId: s.deviceId,
          sessionId: s.sessionId,
        });
      }
    for (const o of visibleOffline) {
      if (seen.has(o.key)) continue;
      seen.add(o.key);
      out.push({
        key: o.key,
        path: sessionPath(o.deviceId, o.sessionId),
        deviceId: o.deviceId,
        sessionId: o.sessionId,
      });
    }
    return out;
  }, [recentRows, filteredGroups, visibleOffline, sessionPath, isMobile]);

  // 进了「最近」区的会话键：分组里那行同键，不得再高亮——否则同一会话在
  // 「最近」与分组两处同亮（去重只改导航目标列表，不改 DOM 上两个同键行）。
  const recentKeys = useMemo(
    () => new Set(recentRows.map((r) => r.key)),
    [recentRows],
  );

  const navIndex = navTargets.findIndex((x) => x.key === selectedKey);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isMobile) return;
      if (e.key === "Escape") {
        setMenu(null);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (navTargets.length === 0) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const base =
          navIndex === -1
            ? e.key === "ArrowDown"
              ? -1
              : navTargets.length
            : navIndex;
        const next = Math.min(navTargets.length - 1, Math.max(0, base + dir));
        setSelectedKey(navTargets[next].key);
        // 选中行可能落在可视区外（长列表）：把高亮滚进视口，
        // block: nearest 保证不做无谓的整页跳动。
        containerRef.current
          ?.querySelector(`[data-nav-target="${navTargets[next].key}"]`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        const target = navTargets.find((x) => x.key === selectedKey);
        if (!target) return;
        // 桌面：Enter = 选中 → 右栏嵌入真实详情；移动：仍走路由详情页。
        if (isMobile) navigate(target.path);
        else onSelect?.(target.deviceId, target.sessionId);
      }
    },
    [isMobile, navTargets, navIndex, selectedKey, navigate, onSelect],
  );

  const handleMenu = useCallback(
    (
      e: React.MouseEvent,
      kind: MenuTarget["kind"],
      fp: string,
      sid: number,
      path?: string,
    ) => {
      if (isMobile) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        kind,
        fingerprint: fp,
        sessionId: sid,
        path,
      });
    },
    [isMobile],
  );

  const handleMenuAction = useCallback(
    (
      kind: MenuTarget["kind"],
      fp: string,
      sid: number,
      path: string | undefined,
      item: string,
    ) => {
      setMenu(null);
      if (item === "open" && path) {
        // 新标签打开：不改当前列表状态，也不伪造“成功”。
        window.open(path, "_blank", "noopener,noreferrer");
      } else if (item === "unfollow") {
        onUnfollow(fp, sid);
      } else if (item === "remove") {
        onRemoveInvalid(fp, sid);
      }
    },
    [onUnfollow, onRemoveInvalid],
  );

  // 桌面点行：把键盘高亮移到该行并让右栏嵌入详情（与 ↑↓/Enter 同一选中语义）。
  const handleRowSelect = useCallback(
    (row: { key: string; deviceId: number; sessionId: number }) => {
      setSelectedKey(row.key);
      onSelect?.(row.deviceId, row.sessionId);
    },
    [onSelect],
  );

  return (
    <div
      ref={containerRef}
      data-testid="chat-list-nav"
      tabIndex={isMobile ? undefined : 0}
      onKeyDown={handleKeyDown}
      aria-label={isMobile ? undefined : t("nav.chat")}
      className={cn(
        "space-y-6",
        !isMobile &&
          "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {/* T6 桌面：筛选 chips（全部 / 运行中 / 未读 N）。 */}
      {!isMobile && (
        <div
          role="group"
          aria-label={t("session.ux.filter.all")}
          className="flex items-center gap-1.5"
        >
          {FILTER_CHIPS.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`filter-chip-${f}`}
              aria-pressed={filter === f}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors",
                filter === f
                  ? "bg-primary-soft text-primary-text"
                  : "text-subtle-foreground hover:bg-accent",
              )}
              onClick={() => setFilter(f)}
            >
              {t(`session.ux.filter.${f}`)}
              {f === "unread" && unread > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-status-waiting px-1 text-[10px] font-semibold text-status-waiting-foreground">
                  {unread}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* T6 桌面：最近 · 跨 Agent（扁平区，跨全部 Agent）。 */}
      {!isMobile && recentRows.length > 0 && (
        <section aria-label={t("session.ux.recent")}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            {t("session.ux.recent")}
          </h2>
          <Card className="py-1">
            <CardContent className="p-1">
              {recentRows.map((r) => (
                <SessionRow
                  key={r.key}
                  row={r}
                  onUnfollow={onUnfollow}
                  sessionPath={sessionPath}
                  t={t}
                  locale={locale}
                  isMobile={false}
                  showFollow={false}
                  selected={selectedKey === r.key}
                  onMenu={(e, path) =>
                    handleMenu(e, "session", r.fingerprint, r.sessionId, path)
                  }
                  onSelect={() => handleRowSelect(r)}
                  testidPrefix="chat-recent-row"
                />
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {filteredGroups.map((group) => (
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
            {group.sessions.length > 0 && (
              <span className="text-xs font-normal text-subtle-foreground">
                {group.sessions.length}
              </span>
            )}
          </h2>
          {group.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("chat.noSessions")}
            </p>
          ) : (
            <Card className="py-1">
              <CardContent className="p-1">
                {group.sessions.map((s) => (
                  <SessionRow
                    key={s.key}
                    row={s}
                    onUnfollow={onUnfollow}
                    sessionPath={sessionPath}
                    t={t}
                    locale={locale}
                    isMobile={isMobile}
                    showFollow={!isMobile}
                    selected={
                      !isMobile &&
                      selectedKey === s.key &&
                      !recentKeys.has(s.key)
                    }
                    onMenu={(e, path) =>
                      handleMenu(e, "session", s.fingerprint, s.sessionId, path)
                    }
                    onSelect={() => handleRowSelect(s)}
                    testidPrefix="chat-row"
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </section>
      ))}

      {pending.length > 0 && (
        <div className="space-y-1">
          {pending.map((p) => (
            <p key={p.key} className="text-sm text-muted-foreground">
              {t("chat.pendingFrom", { machine: p.deviceName })}
            </p>
          ))}
        </div>
      )}

      {visibleOffline.length > 0 && (
        <section aria-label={t("chat.offlineTitle")}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            {t("chat.offlineTitle")}
          </h2>
          <Card className="py-1">
            <CardContent className="p-1">
              {visibleOffline.map((o) => (
                <OfflineRow
                  key={o.key}
                  row={o}
                  onUnfollow={onUnfollow}
                  sessionPath={sessionPath}
                  t={t}
                  isMobile={isMobile}
                  selected={!isMobile && selectedKey === o.key}
                  onMenu={(e, path) =>
                    handleMenu(e, "offline", o.fingerprint, o.sessionId, path)
                  }
                  onSelect={() => handleRowSelect(o)}
                />
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {invalid.length > 0 && (
        <section aria-label={t("chat.invalidTitle")}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            {t("chat.invalidTitle")}
          </h2>
          <Card className="py-1">
            <CardContent className="p-1">
              {invalid.map((inv) => (
                <InvalidRow
                  key={inv.key}
                  row={inv}
                  onRemove={onRemoveInvalid}
                  t={t}
                  onMenu={(e) =>
                    handleMenu(
                      e,
                      "invalid",
                      inv.fingerprint,
                      inv.sessionId,
                      undefined,
                    )
                  }
                />
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {/* T6 桌面：行上右键菜单（只放真实后端动作）。 */}
      {menu && (
        <RowContextMenu
          menu={menu}
          onAction={handleMenuAction}
          onClose={() => setMenu(null)}
          t={t}
        />
      )}
    </div>
  );
}
