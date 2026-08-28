import { rpcMethods } from "@agentre-hub/agentre-wire";
import type {
  EventFrame,
  JournaledNotification,
  SessionSummary,
} from "@agentre-hub/agentre-wire";

import { api } from "@/lib/api";
import { applyJournalFrames, RelayClient } from "@/lib/relayClient";
import { ensureRelayTicket } from "@/lib/relayTicket";
import { relayClientUrl } from "@/lib/relayUrl";

/**
 * GET /v1/agent-sessions 的一行。前两列是身份（决策 17 的键），其余是这条对话
 * 在**账号**里记着的样子 —— 机器离线时中继给不出摘要，头部认得出这条对话全靠它。
 *
 * cwd 不在这里，而且永远不会在（R19：路径不下行），所以由它派生的摘要上没有 cwd。
 */
export interface MirrorSessionItem {
  peer_fingerprint: string;
  session_id: string;
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
 * 认出这条对话在账号镜像里的那一行。身份键是 (**发起端**指纹, 会话 id)（决策 17），
 * 而路由给的是**承载**这条连接的设备 —— 同一条对话常常桌面端与 agentred 各有一份，
 * 发起的那一端不一定就是你点进来的这台机器。
 *
 * 顺序：索引行已经交出发起端指纹时就认那一行；否则先认这台机器自己发起的那条，
 * 再否则认账号里唯一一条同号对话。再往下是歧义：猜错发起端会把**别的对话**摆在
 * 这个 URL 下，那比空着严重得多，所以不猜。
 *
 * 交回的是整行而不只是那个指纹：标题与 Agent 身份都在这一行上，而机器离线时中继
 * 根本给不出摘要，头部要认得出这条对话就只剩这一条来路。
 *
 * 读不到（端点失败 / 没有这一行）时交回 undefined 而不抛：调用方手里可能已经有
 * 索引行传下来的指纹，转录照读得到，不该被这一次取数失败连坐。
 */
export async function resolveMirrorRow(
  sessionId: number,
  origin: string | undefined,
  deviceFingerprint: string | undefined,
): Promise<MirrorSessionItem | undefined> {
  // 按会话号精确查（规格 2026-08-19 决策 13）：索引分页之后「拉全份再本地筛」
  // 只筛得到第一页，本来存在的对话会被当成不存在，页面于是显示成空。
  let rows: MirrorSessionItem[];
  try {
    const res = await api<{ items?: MirrorSessionItem[] }>(
      `/v1/agent-sessions?session_id=${encodeURIComponent(String(sessionId))}`,
    );
    rows = (res.items ?? []).filter((r) => r.session_id === String(sessionId));
  } catch {
    return undefined;
  }
  if (origin) return rows.find((r) => r.peer_fingerprint === origin);
  const own = rows.find((r) => r.peer_fingerprint === deviceFingerprint);
  if (own) return own;
  return rows.length === 1 ? rows[0] : undefined;
}

/**
 * 账号镜像那一行 → 详情头部认得动的摘要。
 *
 * 它是**离线时的替补**，不是中继摘要的等价物：latestSeq 只有承载这条会话的执行端
 * 才知道（这里填 0，补齐的游标另有 mirrorSeqRef 一路），cwd 则永不下行（R19）。
 * 缺的字段一律如实留空，不猜、不填占位。
 */
export function mirrorRowToSummary(
  row: MirrorSessionItem,
  sessionId: number,
): SessionSummary {
  return {
    sessionId,
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
 * 承载连接的那台未必是发起这条对话的那台，而两边各有一份自己的会话行。这里为发起端
 * 单开一条短连接写一次，写完就关——它不是这个页面的长连接，没有事件要收。
 *
 * 够不着（那台离线、或它太老不认识这个方法）时**抛出**，由调用方折进「只写成一台」：
 * 这一次选择在承载者上确实生效了，回滚掉是在说一句假话。
 */
export async function writeModelTargetToOrigin(
  origin: string,
  params: { sessionId: number; providerKey: string; modelKey: string },
): Promise<void> {
  const ticket = await ensureRelayTicket();
  const client = new RelayClient({
    url: relayClientUrl(origin, ticket.accessToken),
    jwt: ticket.accessToken,
    deviceFingerprint: ticket.clientId,
    reconnect: false,
  });
  try {
    await client.connect();
    await client.request(rpcMethods.setModelTarget, {
      ...params,
      sessionId: BigInt(params.sessionId),
      peerFingerprint: origin,
    });
  } finally {
    client.close();
  }
}

/**
 * 从 server 镜像取这条对话**最后那一段**（规格 2026-08-21-transcript-tail-loading）。
 *
 * beforeSeq=0 是首屏（从最新往回）；往上滚续读时传手上最老那条的 seq，服务端按它
 * 作排他上界再给一页。一页有多大由服务端的预算说了算，这边不传 limit。
 *
 * 交回的 lastSeq 是这一页里**最新**那条原始行的 seq（服务端的 cursor，按原始行算，
 * 与投影削掉了多少无关）：首屏拿它预置中继游标，实时流从它之后接上。
 */
export async function loadMirrorTail(
  sessionId: number,
  origin: string,
  beforeSeq: number,
): Promise<{
  events: EventFrame[];
  lastSeq: number;
  oldestSeq: number;
  hasBefore: boolean;
  frameCount: number;
}> {
  const events: EventFrame[] = [];
  const query = new URLSearchParams({
    peer_fingerprint: origin,
    session_id: String(sessionId),
    direction: "backward",
    cursor: String(beforeSeq),
  });
  const page = await api<MirrorTranscriptPage>(
    `/v1/agent-sessions/transcript?${query.toString()}`,
  );
  applyJournalFrames(page.frames ?? [], {
    onEvent: (f) => events.push(f),
    // 轮次结束在转录里是一条分隔标记。实时那条还兼着翻「这一轮在不在跑」并刷新
    // 待决策 —— 那两件事回放教不了（见 turnActiveRef），所以这里只留标记。
    onRunResultDone: () =>
      events.push({ sessionId, event: { kind: "done" }, seq: undefined }),
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
