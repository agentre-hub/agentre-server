/**
 * 「这条会话需不需要你」在本站的**宿主适配层**。
 *
 * 判定、投影与文案都住在共享包（`@agentre-hub/agentre-ui` 的 session-index/attention），
 * 与桌面端逐字同源。此前本站各画了一份缩水的：`toAgentStatus` 只是
 * `reasonToDisplayStatus` 的一半，「未读」只剩 chip 上一个总数（看得见「有 3 条未读」
 * 却看不出是哪三条），attention 气泡里的 rank 干脆硬写成 `"waiting"`。
 *
 * 留在这里的只有「事实从哪来」：本站的事实是账号镜像的那一行（wire 的
 * `SessionSummary` 投影），不是桌面端的 store。
 */
import {
  AGENTRE_UI_NAMESPACE,
  computeAttention,
  lifecycleToAgentStatus,
  reasonToPillText as reasonToPillTextWith,
  type AgentStatus,
  type AttentionReason,
} from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";

/** 判定要用到的那几格。宿主的行比它宽，这里只声明读到的部分。 */
export interface AttentionRowInput {
  lifecycleState: string;
  waitingForInput?: boolean;
  updatedAt?: number;
  lastReadAt?: number;
  /** 还没保存进账号的行不参与「未读」——账号里压根没有它。 */
  saved?: boolean;
}

/**
 * 一行的 attention 判定。
 *
 * `needsAttention` 取 `waitingForInput`：那是 daemon 现算的「有待决的审批 / 提问挡在
 * 那里」，与桌面端 store 里那一格是同一件事。
 *
 * 没保存过的行把两个时刻都抹平成 0，于是 `lastMessageAt > lastReadAt` 不成立、
 * 判不出「未读」——与 `matchesSessionFilter` 和服务端筛选那一档同一条口径。抹的是
 * **输入**而不是在结果上再补一个 if：判定只有包里那一处，本站不在它外面加分支。
 */
export function attentionReasonOf(
  row: AttentionRowInput,
): AttentionReason | null {
  const inAccount = row.saved !== false;
  return computeAttention({
    agentStatus: toAgentStatus(row),
    needsAttention: !!row.waitingForInput,
    lastMessageAt: inAccount ? (row.updatedAt ?? 0) : 0,
    lastReadAt: inAccount ? (row.lastReadAt ?? 0) : 0,
  });
}

/**
 * 一行的生命周期 → 展示用的 `AgentStatus`。判定在共享包里（`lifecycleToAgentStatus`
 * 是两端唯一的一份），这里只是把本站行上的两格喂进去。
 *
 * 它住在 attention 这一层而不是 `lib/sessionView`：`sessionView` 的
 * `matchesSessionFilter` 现在要问 `attentionReasonOf`，而后者又要 agentStatus——
 * 反过来放会绕成一个环。`sessionView` 从这里再导出一次，调用点一个都不用改。
 */
export function toAgentStatus(s: {
  lifecycleState: string;
  waitingForInput?: boolean;
}): AgentStatus {
  return lifecycleToAgentStatus({
    lifecycleState: s.lifecycleState,
    waiting: s.waitingForInput,
  });
}

/**
 * 记号上的文案。包的 key 落在它自己的 namespace 下，绑定只有这一处 —— 漏掉
 * `{ ns }` 的那次会静默落到本站的 defaultNS 上，取不到就把 key 原样显示给用户。
 */
export function attentionPillText(
  reason: AttentionReason | null,
): string | null {
  return reasonToPillTextWith(reason, (key) =>
    i18n.t(key, { ns: AGENTRE_UI_NAMESPACE }),
  );
}
