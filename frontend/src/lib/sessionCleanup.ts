/**
 * 控制台「批量清理已保存对话」的 REST 调用与视图映射。
 *
 * 共享包的 SessionCleanupSection 只认 `SessionCleanupPorts` 的 view；这里是它在浏览器
 * 里的那一半：把「30d / 90d / 180d / all」换成截止毫秒、把 `all` 换成服务端要的空串，
 * 并把服务端交出的失败原因码用本站文案重说——界面上绝不出现原码。
 */
import type {
  CleanupBefore,
  CleanupExecuteView,
  CleanupFilter,
  CleanupPreviewView,
} from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import { api } from "@/lib/api";

const DAY_MS = 86_400_000;
const BEFORE_DAYS: Record<Exclude<CleanupBefore, "all">, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
};

/** 时间档 → 截止毫秒；`all` = null（不限时间）。 */
function cutoffOf(before: CleanupBefore, now: number): number | null {
  return before === "all" ? null : now - BEFORE_DAYS[before] * DAY_MS;
}

const ALL = "all";

interface PreviewPayload {
  count: number;
  retained: number;
  machines?: {
    fingerprint: string;
    name: string;
    online: boolean;
    count: number;
  }[];
  conversation_ids?: string[];
}

interface ExecutePayload {
  deleted: number;
  retained: number;
  failed?: { conversation_id: string; reason: string }[];
  pending?: { fingerprint: string; name: string; count: number }[];
}

export async function previewCleanup(
  filter: CleanupFilter,
  now: number = Date.now(),
): Promise<CleanupPreviewView> {
  const cutoff = cutoffOf(filter.before, now);
  const got = await api<PreviewPayload>("/v1/saved-sessions/cleanup/preview", {
    method: "POST",
    body: JSON.stringify({
      before_ms: cutoff ?? 0,
      agent_sync_id: filter.agentId === ALL ? "" : filter.agentId,
      project_sync_id: filter.projectId === ALL ? "" : filter.projectId,
    }),
  });
  const ids = got.conversation_ids ?? [];
  return {
    count: got.count,
    retained: got.retained,
    cutoffDate: cutoff,
    ids,
    // 控制台的确认框只按机器列（执行端与发起端桌面，由服务端算好）。
    copies: (got.machines ?? []).map((m) => ({
      kind: "machine" as const,
      label: m.name,
      online: m.online,
      count: m.count,
    })),
  };
}

/** 服务端失败原因码 → 文案键（写成字面量，才查得到「这个键有读者」）。 */
const REASON_KEYS: Record<string, string> = {
  machine_protocol_violation:
    "settings.privacy.cleanup.reason.machine_protocol_violation",
  delete_failed: "settings.privacy.cleanup.reason.delete_failed",
};

/** 失败原因码 → 本站文案；不认识的码落到通用说法，不透出原码。 */
function reasonText(code: string): string {
  return i18n.t(
    Object.hasOwn(REASON_KEYS, code)
      ? REASON_KEYS[code]
      : "settings.privacy.cleanup.reason.unknown",
  );
}

/**
 * 一次请求送多少条。服务端单次上限是 5000（CleanupRequest 的 binding），而预览给出的
 * 清单不设上限；服务端又是逐条删、逐台机器通知，批小一些每个请求的耗时才有界。
 */
const EXECUTE_BATCH = 500;

async function executeBatch(ids: string[]): Promise<CleanupExecuteView> {
  const got = await api<ExecutePayload>("/v1/saved-sessions/cleanup", {
    method: "POST",
    body: JSON.stringify({ conversation_ids: ids }),
  });
  return {
    deleted: got.deleted,
    failed: (got.failed ?? []).map((f) => ({
      id: f.conversation_id,
      reason: reasonText(f.reason),
    })),
    pending: (got.pending ?? []).map((p) => ({
      label: p.name,
      count: p.count,
    })),
  };
}

/**
 * 分批执行并合并结果。第一批就整个失败时原样抛出（确认框据此原样重试）；之后某一批
 * 失败时，已删的照报，那一批及其后没送成的列为失败，由「重试剩下的」接着送。
 */
export async function executeCleanup(
  ids: string[],
): Promise<CleanupExecuteView> {
  const out: CleanupExecuteView = { deleted: 0, failed: [], pending: [] };
  const pending = new Map<string, number>();
  for (let i = 0; i < ids.length; i += EXECUTE_BATCH) {
    let got: CleanupExecuteView;
    try {
      got = await executeBatch(ids.slice(i, i + EXECUTE_BATCH));
    } catch (err) {
      if (i === 0) throw err;
      const reason = reasonText("");
      out.failed.push(...ids.slice(i).map((id) => ({ id, reason })));
      break;
    }
    out.deleted += got.deleted;
    out.failed.push(...got.failed);
    for (const p of got.pending) {
      pending.set(p.label, (pending.get(p.label) ?? 0) + p.count);
    }
  }
  out.pending = [...pending].map(([label, count]) => ({ label, count }));
  return out;
}
