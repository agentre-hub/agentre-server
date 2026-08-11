import type { SessionSummary } from "@/lib/wire";

export interface SessionCopy<T = undefined> {
  sourceFingerprint: string;
  sourceKind: string;
  summary: SessionSummary;
  value?: T;
}

export interface MergedSessionCopy<T = undefined> extends SessionCopy<T> {
  historyIncomplete: boolean;
}

function mergeKey(copy: SessionCopy<unknown>, index: number): string {
  const peer = copy.summary.peerFingerprint?.trim();
  if (!peer) {
    // 没有发起端指纹时不能只按 SessionID 合并：不同发起端可合法地产生同号会话。
    return `unmergeable\u0000${copy.sourceFingerprint}\u0000${copy.summary.sessionId}\u0000${index}`;
  }
  return `${peer}\u0000${copy.summary.sessionId}`;
}

/**
 * R20：按（发起端指纹，SessionID）合并同一会话的多份清单摘要。
 * 桌面端持有完整标题与转录，因此无论输入顺序都优先；只有桌面端副本不在场时才
 * 保留 agentred 副本。agentred 副本属于某个已知桌面发起端时，明确标记历史不完整。
 */
export function mergeSessionCopies<T>(
  copies: SessionCopy<T>[],
  desktopFingerprints: ReadonlySet<string> = new Set(),
): MergedSessionCopy<T>[] {
  const byKey = new Map<string, SessionCopy<T>>();
  copies.forEach((copy, index) => {
    const key = mergeKey(copy, index);
    const current = byKey.get(key);
    if (
      !current ||
      (copy.sourceKind === "desktop" && current.sourceKind !== "desktop")
    ) {
      byKey.set(key, copy);
    }
  });

  return [...byKey.values()].map((copy) => ({
    ...copy,
    historyIncomplete:
      copy.sourceKind === "agentred" &&
      desktopFingerprints.has(copy.summary.peerFingerprint?.trim() ?? ""),
  }));
}
