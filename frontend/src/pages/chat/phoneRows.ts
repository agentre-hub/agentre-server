import { attentionReasonOf, toAgentStatus } from "@/lib/attentionAdapter";
import type { SessionFilter } from "@/lib/sessionView";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";

/**
 * 手机首页的筛选胶囊：全部 / 需要你 / 进行中 / 未读（规格 2026-11-05「首页」）。
 *
 * 「需要你」与「进行中」在这一页上与分段同一个口径（`lifecycleToAgentStatus`）：
 * 需要你 = 等你输入，进行中 = 在跑**且不在等你**。端点只认 全部 / 运行中 / 未读，
 * 这两档都先向它要「运行中」（等你输入是运行期的叠加事实，在那一档里），再在本地
 * 按状态收窄——不另加端点。
 */
export type PhoneFilter = SessionFilter | "attention";

/** 这一档向端点要哪一档。 */
export function dataFilterOf(filter: PhoneFilter): SessionFilter {
  return filter === "attention" ? "running" : filter;
}

/** 端点那一档之上，本地再收窄一步（只有「需要你」「进行中」要）。 */
export function narrowPhoneRows(
  rows: MirrorIndexRow[],
  filter: PhoneFilter,
): MirrorIndexRow[] {
  if (filter === "attention") {
    return rows.filter((row) => toAgentStatus(row) === "waiting");
  }
  if (filter === "running") {
    return rows.filter((row) => toAgentStatus(row) === "running");
  }
  return rows;
}

/** 未读只问唯一的那一处判据（`attentionReasonOf`），不在这里另比时刻。 */
export function isRowUnread(row: MirrorIndexRow): boolean {
  return attentionReasonOf(row) === "unread";
}

export interface PhoneCounts {
  attention: number;
  running: number;
  unread: number;
}

/** 一批行里三枚胶囊各有几条。 */
export function countPhoneRows(rows: MirrorIndexRow[]): PhoneCounts {
  let attention = 0;
  let running = 0;
  let unread = 0;
  for (const row of rows) {
    const status = toAgentStatus(row);
    if (status === "waiting") attention += 1;
    else if (status === "running") running += 1;
    if (isRowUnread(row)) unread += 1;
  }
  return { attention, running, unread };
}

/** `phaseSections` 要的那一份形状：行原样带着走。 */
export function toPhaseItem(row: MirrorIndexRow) {
  return {
    ...row,
    waiting: row.waitingForInput,
    lastMessageAt: row.updatedAt,
  };
}

/** 本地时区的今天零点（「今天 / 更早」的分界由宿主给，包不猜时区）。 */
export function startOfToday(now: number): number {
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}
