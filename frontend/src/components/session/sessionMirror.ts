import { rpcMethods } from "@agentre-hub/agentre-wire";
import type {
  JournaledNotification,
  SessionSummary,
} from "@agentre-hub/agentre-wire";

import {
  toTranscriptFrame,
  type SessionEventFrame,
} from "@/components/session/transcriptFrame";
import { doneEventFrame } from "@/components/session/turnDone";
import { api } from "@/lib/api";
import { applyJournalFrames } from "@/lib/relayClient";
import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

/**
 * GET /v1/agent-sessions 的一行。第一列是身份（`conversation_id`，决策 1），其余是
 * 这条对话在**账号**里记着的样子 —— 机器离线时中继给不出摘要，头部认得出这条对话
 * 全靠它。
 *
 * cwd 不在这里，而且永远不会在（R19：路径不下行），所以由它派生的摘要上没有 cwd。
 */
export interface MirrorSessionItem {
  conversation_id: string;
  /** 发起这条对话那一端的指纹。留作来源标注与授权，不再是身份的一半。 */
  peer_fingerprint: string;
  /** 当前承载这条对话的机器；与发起端可以不同。 */
  machine_fingerprint: string;
  title?: string;
  agent_sync_id?: string;
  backend_type?: string;
  lifecycle_state?: string;
  waiting_for_input?: boolean;
  last_message_at?: number;
  /**
   * 这条对话自己钉的 ModelTarget（两者皆空 = 跟随 Agent 绑定）。镜像自发起端那两列，
   * 机器离线时模型那一格据此仍显示得出——这正是「已保存」承诺的一部分。
   */
  provider_key?: string;
  model_key?: string;
}

/**
 * GET /v1/agent-sessions/transcript 的一页。frames 是 wire.JournaledNotification 原样，
 * 因此解得动它的是与实时流同一条路径（applyJournalFrames）。
 *
 * cursor 是**这一次读到哪**，不是这条对话的最新 seq —— 机器在线时实时流还在往前跑，
 * 拿它当「到此为止都读完了」会把后面的实时帧全判成重复。这里只用它翻下一页。
 */
export interface MirrorTranscriptPage {
  frames?: JournaledNotification[];
  cursor: number;
  has_more: boolean;
  /** 反向读那一页里最老那条的 seq —— 往上翻的下一次入参。 */
  oldest_seq?: number;
  /** 还有没有更早的。 */
  has_before?: boolean;
}

/**
 * 取这条对话在账号镜像里的那一行。
 *
 * 从前这里有一整段**猜**：身份是 (发起端指纹, 那一端的会话号) 一对，而 URL 上只有
 * 会话号，于是要按「索引行给了发起端就认那一行、否则先认这台机器自己发起的、再否则
 * 认账号里唯一一条同号的」逐级退让。`conversation_id` 全局唯一之后没有可猜的余地：
 * 按它精确查，至多命中一行（服务端 `SavedSessionsRequest.conversation_id` 那条路
 * 不分组、不分页）。
 *
 * 交回的是整行：标题、Agent 身份、模型目标都在这一行上，而机器离线时中继根本给不出
 * 摘要，头部要认得出这条对话就只剩这一条来路；`machine_fingerprint` 同时是「该连
 * 哪台机器」的答案。
 *
 * 读不到（端点失败 / 没有这一行）时交回 undefined 而不抛：调用方手里可能已经有索引
 * 行传下来的东西，转录照读得到，不该被这一次取数失败连坐。
 */
export async function fetchMirrorRow(
  conversationId: string,
): Promise<MirrorSessionItem | undefined> {
  try {
    const res = await api<{ items?: MirrorSessionItem[] }>(
      `/v1/agent-sessions?conversation_id=${encodeURIComponent(conversationId)}`,
    );
    return (res.items ?? []).find((r) => r.conversation_id === conversationId);
  } catch {
    return undefined;
  }
}

/**
 * 账号镜像那一行 → 详情头部认得动的摘要。
 *
 * 它是**离线时的替补**，不是中继摘要的等价物：latestSeq 只有承载这条会话的执行端
 * 才知道（这里填 0，补齐的游标另有 mirrorSeqRef 一路），cwd 则永不下行（R19）。
 * 缺的字段一律如实留空，不猜、不填占位。
 */
export function mirrorRowToSummary(row: MirrorSessionItem): SessionSummary {
  return {
    conversationId: row.conversation_id,
    peerFingerprint: row.peer_fingerprint,
    title: row.title,
    agentSyncId: row.agent_sync_id,
    backendType: row.backend_type,
    lifecycleState: row.lifecycle_state ?? "",
    waitingForInput: row.waiting_for_input,
    updatedAt: row.last_message_at,
    latestSeq: 0,
    providerKey: row.provider_key,
    modelKey: row.model_key,
  };
}

/**
 * 把模型目标也写到**发起端**那一台。
 *
 * 承载连接的那台未必是发起这条对话的那台，而两边各有一份自己的会话行。这里向池子借
 * 一条到发起端**机器**的通道写一次，写完还回去——它不是这个页面的长连接，没有事件要收。
 * 走 `machine:` 而不是 `conversation:`：目标就是「那一台」，而服务端按对话解析出的是
 * **承载**机器，正是这里要绕开的那一台。
 *
 * 够不着（那台离线、或它太老不认识这个方法）时**抛出**，由调用方折进「只写成一台」：
 * 这一次选择在承载者上确实生效了，回滚掉是在说一句假话。
 */
export async function writeModelTargetToOrigin(
  origin: string,
  params: { conversationId: string; providerKey: string; modelKey: string },
): Promise<void> {
  await withRelayClient(machineTarget(origin), async (client) => {
    await client.request(rpcMethods.setModelTarget, {
      ...params,
      peerFingerprint: origin,
    });
  });
}

/**
 * 从 server 镜像取这条对话**最后那一段**（规格 2026-08-21-transcript-tail-loading）。
 *
 * beforeSeq=0 是首屏（从最新往回）；往上滚续读时传手上最老那条的 seq，服务端按它
 * 作排他上界再给一页。一页有多大由服务端的预算说了算，这边不传 limit。
 *
 * 入参只有 `conversation_id`：端点的身份键换成它之后不再需要发起端指纹——那正是
 * 从前那段猜测存在的理由。
 *
 * 交回的 lastSeq 是这一页里**最新**那条原始行的 seq（服务端的 cursor，按原始行算，
 * 与投影削掉了多少无关）：首屏拿它预置中继游标，实时流从它之后接上。
 */
export async function loadMirrorTail(
  conversationId: string,
  beforeSeq: number,
): Promise<{
  events: SessionEventFrame[];
  lastSeq: number;
  oldestSeq: number;
  hasBefore: boolean;
  frameCount: number;
}> {
  const events: SessionEventFrame[] = [];
  const query = new URLSearchParams({
    conversation_id: conversationId,
    direction: "backward",
    cursor: String(beforeSeq),
  });
  const page = await api<MirrorTranscriptPage>(
    `/v1/agent-sessions/transcript?${query.toString()}`,
  );
  applyJournalFrames(page.frames ?? [], {
    onEvent: (f) => events.push(toTranscriptFrame(f)),
    // 轮次结束在转录里是一条分隔标记，同时是这一轮 meta（模型 / 耗时 / 首字 /
    // 速率）的唯一来路 —— 见 doneEventFrame。实时那条还兼着翻「这一轮在不在跑」
    // 并刷新待决策，那两件事回放教不了（见 turnActiveRef），这里只有标记这一半。
    onRunResultDone: (frame) =>
      events.push(doneEventFrame(conversationId, frame)),
  });
  return {
    events,
    // 用服务端交回的 cursor 而不是 applyJournalFrames 的返回值：后者是**投影后**
    // 那些帧里的最大 seq，而窗口最末那帧可能正好被投影丢掉了。差这一格，随后每条
    // 实时帧都会被判成跳号。
    lastSeq: page.cursor ?? 0,
    oldestSeq: page.oldest_seq ?? 0,
    hasBefore: !!page.has_before,
    frameCount: (page.frames ?? []).length,
  };
}
