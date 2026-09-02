import type { EventFrame, RunResultDoneFrame } from "@agentre-hub/agentre-wire";

import {
  toTranscriptFrame,
  type SessionEventFrame,
} from "@/components/session/transcriptFrame";

/**
 * 终态帧（`runtime.runResultDone`）→ 转录里的那条结束标记。
 *
 * 三条读取路径都要用它：实时推送（SessionDetailView）、重连补齐与向前翻页
 * （useTranscriptScrollback）、账号镜像回放（sessionMirror）。所以它在这里，
 * 不在三处各写一句。
 *
 * 为什么不只是 `{ kind: "done" }`：这一帧是本轮 meta 的**唯一**来路。模型、耗时、
 * 首字与速率在 wire 上只出现在这里 —— `usage` 帧上根本没有 model 字段，而计时是
 * agentred 就着它自己扇出的那条事件流量出来的（口径与桌面端 chat_svc 共用
 * `internal/pkg/turnstats`），落库那一份过不了 wire。三处从前把这一帧压成一条空
 * 标记，控制台的 meta 就永远是「模型 —、耗时 0.0s」。
 *
 * 零值一律**不出现**，不补进事件里：共享包把 0 读作「有这个数，值是 0」，
 * `durationMs: 0` 会画出一条「0.0s」——那是在替对端撒谎，而老 agentred 真实的
 * 意思是「我还答不出这个数」。判据取真值而不是 `!== undefined`：这条链路上
 * 「零值 = 没有」是既定约定（Protobuf 的缺省字段解出 0，镜像投影按
 * `wireview.putNonzero` 省略零值、`journaledToFrame` 又把它补回 0），
 * 两头都到不了 undefined。归约（落到哪条消息、用量怎么合并）归共享包。
 *
 * `seq` 留空：这条标记是宿主合成的，不占中继日志的序号。
 */
export function doneEventFrame(
  conversationId: string,
  frame: RunResultDoneFrame,
  createtime = 0,
): SessionEventFrame {
  const event: Record<string, unknown> = { kind: "done" };
  if (frame.model) event.model = frame.model;
  if (frame.durationMs) event.durationMs = frame.durationMs;
  if (frame.firstTokenMs) event.firstTokenMs = frame.firstTokenMs;
  if (frame.tokensPerSec) event.tokensPerSec = frame.tokensPerSec;
  if (frame.usage) event.usage = { ...frame.usage };
  return toTranscriptFrame(
    {
      conversationId,
      event,
      seq: undefined,
    } as EventFrame,
    // 这条标记合成自终态帧，时刻因此就是那一帧的。它落在**已经开着**的那条助手消息
    // 上（归约器的 done 分支不新建消息），所以这个值实际上不会成为谁的 createtime——
    // 传它是为了不在这条路上凭空断掉时刻，而不是为了让它显示出来。
    createtime,
  );
}
