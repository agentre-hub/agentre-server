/**
 * 会话视图状态（R11）：四类不可达与失效各自可区分，不折叠成同一个错误。
 *
 * 由纯函数 deriveSessionViewStatus 从底层信号导出，便于 vitest 直接构造各状态断言
 * 文案互不相同（测试接缝 6）。四类状态：
 *   - machineOffline —— 目标 agentred 离线（R11 第 1 类）
 *   - reconnecting / lost / connected —— 浏览器与 server 之间断线（R11 第 2 类，
 *     按既有的 connected / reconnecting / lost 表达）
 *   - revoked —— 本浏览器已被解除授权，须重新登录（R11 第 3 类）
 *   - loggedOut —— 账号已登出（R11 第 4 类）
 *
 * 优先级：账号登出 > 解除授权 > 机器离线 > 中继连接态。优先级由可探测性决定：
 * 账号没了其余全无意义；设备被解除授权后任何注册 / 连接都不该继续；机器离线时
 * 中继必然连不上，没必要先演一段「连接中」。
 */
import type { RelayState } from "@/lib/relayClient";

export type SessionViewStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "lost"
  | "machineOffline"
  | "revoked"
  | "loggedOut";

export interface SessionViewInput {
  /** 中继连接状态（RelayClient.onStateChange 的直接透传）。 */
  relayState: RelayState;
  /** /v1/auth/me 是否有效（false = 账号已登出）。 */
  meValid: boolean;
  /** 本浏览器（kind=web 设备）是否已被解除授权。 */
  webDeviceRevoked: boolean;
  /** 目标 agentred 是否在线；null = 尚未探知。 */
  machineOnline: boolean | null;
}

export function deriveSessionViewStatus(
  input: SessionViewInput,
): SessionViewStatus {
  const { relayState, meValid, webDeviceRevoked, machineOnline } = input;
  if (!meValid) return "loggedOut";
  if (webDeviceRevoked) return "revoked";
  if (machineOnline === false) return "machineOffline";
  switch (relayState) {
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "connecting":
      return "connecting";
    default:
      return "lost";
  }
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/**
 * 「最后活动时间」的相对形态（R5，mockup 帧 45a 的「2分前」）。
 *
 * 走 Intl.RelativeTimeFormat 而不是 t(...)：它渲染的是**动态时刻**，与列表里既有的
 * `toLocaleString()` 同类，不是静态 UI 文案。locale 由调用方从 i18n.language 传入。
 */
export function formatRelativeTime(
  ms: number,
  locale: string,
  now: number = Date.now(),
): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, span] of RELATIVE_UNITS) {
    if (abs >= span) return fmt.format(Math.round(diff / span), unit);
  }
  return fmt.format(0, "minute");
}

/**
 * T6（p5Orc「优化」）会话列表 UX 的纯函数：筛选 chips、未读数、「最近」排序、状态点。
 * 全部无副作用，便于 vitest 直接断言行为（见 session-list.test.tsx 的
 * 「sessionView 纯函数」一组）。
 */

/** 筛选 chips 的取值。all = 不过滤；running = 运行中且不等待输入；unread = 等待输入。 */
export type SessionFilter = "all" | "running" | "unread";

/**
 * 一条会话是否落在某个筛选下。
 * 「正在等输入」是运行之上的实时叠加：它不进「运行中」（未读置顶优先），
 * 只进「未读」；其余按生命周期是否 running 判定。
 */
export function matchesSessionFilter(
  s: { lifecycleState: string; waitingForInput?: boolean },
  filter: SessionFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return !!s.waitingForInput;
  return s.lifecycleState === "running" && !s.waitingForInput;
}

/** 未读（等待输入）的会话数，喂给「未读 N」chip 的计数。 */
export function unreadCount(rows: { waitingForInput?: boolean }[]): number {
  return rows.filter((r) => !!r.waitingForInput).length;
}

/**
 * 「最近」的排序键：updatedAt 与 followedAt 取新（关注时间也是这条会话最近的动静
 * 之一）。两者皆缺时返回 0 —— 排最后，不猜一个时刻。
 */
export function recentTimestamp(
  updatedAt: number | undefined,
  followedAt: number | undefined,
): number {
  return Math.max(updatedAt ?? 0, followedAt ?? 0);
}

/** 「最近」区的可排序项：key 用于去重定位，recent 是排序键。 */
export interface RecentOrderable {
  key: string;
  recent: number;
}

/** 取最近 N 条（按 recent 降序）。不足 N 时全取；排序稳定，同刻保持原顺序。 */
export function takeRecent<T extends RecentOrderable>(
  rows: T[],
  n: number,
): T[] {
  return [...rows].sort((a, b) => b.recent - a.recent).slice(0, n);
}

/**
 * 行首状态点的颜色（对应设计稿的 ok / warn / idle / danger）：等待输入=琥珀、
 * 运行中=绿、已中断=红、其余（idle 与不认识的旧状态）=灰。走 token，不写字面量。
 */
export function statusDotClass(s: {
  lifecycleState: string;
  waitingForInput?: boolean;
}): string {
  if (s.waitingForInput) return "bg-status-waiting";
  switch (s.lifecycleState) {
    case "running":
      return "bg-status-running";
    case "interrupted":
      return "bg-status-error";
    default:
      return "bg-status-idle";
  }
}
