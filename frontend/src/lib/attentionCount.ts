/**
 * 侧栏与移动底栏「对话」那颗角标的取数。
 *
 * 单开一条端点而不是让外壳去拉一页会话索引：这条路在**每一次进入任何页面**时都会跑
 * 一遍，而一页摘要里的标题、游标、项目归属一个都用不上。
 *
 * 判据（「需要你」是哪几档）住在服务端仓储的 `attentionExpr`，与索引上那几个筛选
 * chip 共用同一处——侧栏说有 3 条等你、点进去筛选却是 2 条，是一种没有任何地方会
 * 报错、而用户一眼就看得见的错。
 *
 * 这件事 2026-09-04 之前一直是错的：这条端点从前叫 `/waiting-count`，只数
 * `waiting_for_input`，而索引上的 chip 在改名成「未读」那一轮换成了
 * `last_message_at > last_read_at`，侧栏没跟上。两个判据毫无关系，联调库上因此出现
 * 侧栏说 1 条、点进去未读筛选是 0 条。
 */
import { api } from "@/lib/api";

/**
 * 账号里此刻需要你的对话条数，按理由分开给。
 *
 * 两个数而不是一个：角标只有一个数字位（画的是它们的和），但它底下是两件事，说明
 * 文字要把它们分开说。在服务端合成一个数交出来的话，那句话就再也拆不回来了。
 */
export interface AttentionCounts {
  /** 有待决的审批 / 提问挡在那里。0 是答案，不是「没问出来」。 */
  needsAttention: number;
  /** 有新东西你还没看过，且没有更强的理由（不在跑、不等你按、上一轮也没跑挂）。 */
  unread: number;
}

/** 线上载荷（下划线键）。 */
interface AttentionCountPayload {
  needs_attention: number;
  unread: number;
}

export async function fetchAttentionCounts(): Promise<AttentionCounts> {
  const r = await api<AttentionCountPayload>(
    "/v1/agent-sessions/attention-count",
  );
  return { needsAttention: r.needs_attention ?? 0, unread: r.unread ?? 0 };
}
