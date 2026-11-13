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
    copies: [
      // 控制台只清账号里保存的这份；执行端的副本由服务端一并处理。
      { kind: "account", label: "", count: got.count },
      ...(got.machines ?? []).map((m) => ({
        kind: "machine" as const,
        label: m.name,
        online: m.online,
        count: m.count,
      })),
    ],
  };
}

/** 失败原因码 → 本站文案；不认识的码落到通用说法，不透出原码。 */
function reasonText(code: string): string {
  const key = `settings.privacy.cleanup.reason.${code}`;
  return i18n.exists(key)
    ? i18n.t(key)
    : i18n.t("settings.privacy.cleanup.reason.unknown");
}

export async function executeCleanup(
  ids: string[],
): Promise<CleanupExecuteView> {
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
