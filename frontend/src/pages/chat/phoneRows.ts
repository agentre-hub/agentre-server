import { attentionReasonOf, toAgentStatus } from "@/lib/attentionAdapter";
import { isEmptyDraft, type Draft } from "@/lib/drafts";
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

/** 排着队、还没发出去的一条（任务「排队与失败消息跟着对话保存」填它）。 */
export interface PendingSend {
  text: string;
}

export type RowSubline = {
  kind: "pending" | "draft" | "content";
  /** pending / draft：消息的首个非空行（只有图时为空串）；content：原样。 */
  text: string;
};

/** 首个非空行，去首尾空白；全空时为空串。 */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * 手机首页行的副行（规格 2026-11-25 C1/C2）：「待发送」＞「[草稿]」＞ 内容。
 * 前缀文案（红色「[草稿]」等）归界面，这里只判哪一档、取哪一行字。
 */
export function rowSubline(
  _row: MirrorIndexRow,
  ctx?: { draft?: Draft; pending?: PendingSend; content?: string },
): RowSubline {
  if (ctx?.pending) {
    return { kind: "pending", text: firstLine(ctx.pending.text) };
  }
  if (ctx?.draft && !isEmptyDraft(ctx.draft)) {
    return { kind: "draft", text: firstLine(ctx.draft.text) };
  }
  return { kind: "content", text: ctx?.content ?? "" };
}
