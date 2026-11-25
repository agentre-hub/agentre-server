/**
 * 对话内容的本地缓存（规格 2026-11-25 决策 A1 的对话部分）：最近打开的 30 条对话，
 * 各存最近一页内容（首屏向镜像要的那一页，加上看着它时实时到的帧）以及认得出这条
 * 对话的那一行与它的 Agent。点进来先画这一页，新的到了再按序号合并（SessionDetailView）。
 *
 * 存在本机（`accountStore`，kind = `transcript`）：按账号隔离，登出 / 401 / 换账号时随
 * 业务数据一起清掉；存储不可用时静默退回「没存」，从不抛错——它只是加速，以服务端为准。
 *
 * 淘汰按**最近打开**：每次打开（`open`）记下打开时刻，超过 30 条就删最久没打开的。
 * 同一次打开期间的更新（`update`）不改打开时刻、也不去数别的条目：实时帧每到一批都要
 * 写一次，每次都把 30 页读一遍不值得。
 */
import type { SessionEventFrame } from "@/components/session/transcriptFrame";
import type { MirrorSessionItem } from "@/components/session/sessionMirror";
import { accountStore } from "@/lib/localStore";

export const TRANSCRIPT_CACHE_KIND = "transcript";

/** 本机最多存这么多条对话的内容。 */
export const TRANSCRIPT_CACHE_LIMIT = 30;

/** 认得出这条对话的 Agent（与 SessionDetailView 的 `initialAgent` 同形）。 */
export interface CachedTranscriptAgent {
  sync_id: string;
  name: string;
  avatar_color?: string;
  avatar_icon?: string;
}

/** 一条对话存下来的那一页。 */
export interface CachedTranscriptPage {
  /** 那一页的帧，按 seq 升序，形状就是转录手里的那一份。 */
  events: SessionEventFrame[];
  /**
   * 这一页画到了哪一格 seq：镜像读不到时，补齐的游标从它接上（高了是洞，低了只是
   * 重复，由按 seq 的闸门挡掉）。
   */
  lastSeq: number;
  /** 这一页最老那一格，往上翻「更早的」从它之前接着问镜像。 */
  oldestSeq: number;
  hasBefore: boolean;
  /** 账号镜像里的那一行：标题与 Agent 身份在它上面。 */
  row?: MirrorSessionItem;
  agent?: CachedTranscriptAgent;
}

export interface CachedTranscript extends CachedTranscriptPage {
  /** 最近一次打开的时刻（Unix 毫秒），淘汰按它。 */
  openedAt: number;
}

/** 对话内容缓存。所有方法都不会拒绝。 */
export const transcriptCache = {
  get(conversationId: string): Promise<CachedTranscript | undefined> {
    return accountStore.get<CachedTranscript>(
      TRANSCRIPT_CACHE_KIND,
      conversationId,
    );
  },

  /** 打开了这条对话：存这一页、记打开时刻，并淘汰超出上限的最久没打开的那几条。 */
  async open(
    conversationId: string,
    page: CachedTranscriptPage,
    now = Date.now(),
  ): Promise<void> {
    await accountStore.put<CachedTranscript>(
      TRANSCRIPT_CACHE_KIND,
      conversationId,
      { ...page, openedAt: now },
    );
    const all = await accountStore.list<CachedTranscript>(
      TRANSCRIPT_CACHE_KIND,
    );
    if (all.length <= TRANSCRIPT_CACHE_LIMIT) return;
    const stale = all
      .sort((a, b) => b.value.openedAt - a.value.openedAt)
      .slice(TRANSCRIPT_CACHE_LIMIT);
    await Promise.all(
      stale.map((r) => accountStore.delete(TRANSCRIPT_CACHE_KIND, r.key)),
    );
  },

  /**
   * 同一次打开期间这一页变了（实时帧到了）：换掉内容，打开时刻沿用。已经被淘汰
   * （或从没打开过）的不写回来。
   */
  async update(
    conversationId: string,
    page: CachedTranscriptPage,
  ): Promise<void> {
    const prev = await transcriptCache.get(conversationId);
    if (!prev) return;
    await accountStore.put<CachedTranscript>(
      TRANSCRIPT_CACHE_KIND,
      conversationId,
      { ...page, openedAt: prev.openedAt },
    );
  },

  /** 这条对话不在账号里了（别处删掉）：丢掉它的那一页。 */
  forget(conversationId: string): Promise<void> {
    return accountStore.delete(TRANSCRIPT_CACHE_KIND, conversationId);
  },
};
