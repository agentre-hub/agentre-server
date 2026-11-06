import { rpcMethods } from "@agentre-hub/agentre-wire";

import { withRelayClient } from "@/lib/relayClientPool";
import { conversationTarget, machineTarget } from "@/lib/relayTarget";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";

/**
 * 长按菜单里的「停止这一轮」：与对话页那颗停止键同一条路（`runtime.abort`，见
 * `components/session/useTurnStop`），只是这里手上没有开着的通道，向中继池借一条。
 *
 * 已保存的按对话寻址（服务端认承载机器）；还没进账号的只能按它所在的那台机器寻址。
 * 停不下来不另开一条错误面：这一轮的状态会照常走下去，行上的状态牌自己说话。
 */
export async function stopRowTurn(row: MirrorIndexRow): Promise<void> {
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
  } catch {
    // 见上：不另开错误面。
  }
}
