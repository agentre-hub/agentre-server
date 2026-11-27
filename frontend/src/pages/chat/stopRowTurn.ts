import { rpcMethods } from "@agentre-hub/agentre-wire";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import i18n from "@/i18n";
import { describeFailure } from "@/lib/describeFailure";
import { withRelayClient } from "@/lib/relayClientPool";
import { conversationTarget, machineTarget } from "@/lib/relayTarget";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";

/**
 * 正在停止的那几行（对话 id）。长按「停止这一轮」一按下去就进来，行上立即写
 * 「正在停止…」（规格 2026-11-25 F2）；失败当场放下，成功则留到这一轮的状态自己落下
 * （行不再是运行中就不再显示），最迟 `STOP_SETTLE_MS` 后放下，免得标记永远挂着。
 */
let stoppingRows: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** 请求成功后最多等这么久：与 `RequestTimeoutMs`（30s）同量级，终态帧早该到了。 */
export const STOP_SETTLE_MS = 30_000;

function setStopping(id: string, on: boolean) {
  if (stoppingRows.has(id) === on) return;
  const next = new Set(stoppingRows);
  if (on) next.add(id);
  else next.delete(id);
  stoppingRows = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useStoppingRows(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => stoppingRows,
    () => stoppingRows,
  );
}

/**
 * 长按菜单里的「停止这一轮」：与对话页那颗停止键同一条路（`runtime.abort`，见
 * `components/session/useTurnStop`），只是这里手上没有开着的通道，向中继池借一条。
 *
 * 已保存的按对话寻址（服务端认承载机器）；还没进账号的只能按它所在的那台机器寻址。
 * 点下去行上立即「正在停止…」，重复点不再发第二次；停不下来在顶部出声
 * 「没停下来」+ 原因 + 「重试」（手机的 toast 落在顶部，不盖输入框与底部操作）。
 */
export async function stopRowTurn(row: MirrorIndexRow): Promise<void> {
  const id = row.conversationId;
  if (stoppingRows.has(id)) return;
  setStopping(id, true);
  const abort = (client: {
    request: (
      method: typeof rpcMethods.runtimeAbort,
      params: object,
    ) => Promise<unknown>;
  }) =>
    client.request(rpcMethods.runtimeAbort, {
      conversationId: row.conversationId,
      ...(row.fingerprint ? { peerFingerprint: row.fingerprint } : {}),
    });
  try {
    if (row.saved === false) {
      await withRelayClient(machineTarget(row.machineFingerprint), abort);
    } else {
      await withRelayClient(conversationTarget(row.conversationId), abort);
    }
    setTimeout(() => setStopping(id, false), STOP_SETTLE_MS);
  } catch (err) {
    setStopping(id, false);
    const t = i18n.t.bind(i18n);
    toast.error(t("chat.stop.failed"), {
      id: `stop-row-${id}`,
      description: describeFailure(err, {
        t,
        what: t("chat.stop.failedWhat"),
      }).message,
      action: {
        label: t("chat.stop.retry"),
        onClick: () => void stopRowTurn(row),
      },
    });
  }
}
