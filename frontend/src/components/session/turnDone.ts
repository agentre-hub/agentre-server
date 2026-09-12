import {
  ErrCodeAborted,
  type EventFrame,
  type RunResultDoneFrame,
} from "@agentre-hub/agentre-wire";

import {
  toTranscriptFrame,
  type SessionEventFrame,
} from "@/components/session/transcriptFrame";

/**
 * 终态帧（`runtime.runResultDone`）→ 转录里的那条结束标记。
 *
 * 三条读取路径都要用它：实时推送（SessionDetailView）、重连补齐与向前翻页
 * （useTranscriptScrollback）、账号镜像回放（sessionMirror）。所以它在这里，
 * 不在三处各写一句。那三处收的是下面的 `turnDoneFrames`——本函数是它的正常收场
 * 那一半，出错收场还要在前面多一条 `error`。
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

/**
 * 终态帧 → 转录里这一轮收场留下的那几条事件。
 *
 * 三条读取路径（实时推送、重连补齐与向前翻页、账号镜像回放）都收这个，而不是各自
 * 调 `doneEventFrame` —— 「出错的一轮要画错误卡」这件事只写在这里一处。
 *
 * 正常收场只有一条 `done`。**出错**收场在它前面多一条 `error`：
 *
 * 停止原因在 wire 上只挂在终态帧的 `stopErrMsg` / `stopErrCode` 上，事件流里没有
 * 对应的 kind（`agentruntime.Done` 那四格里没有错误位，桌面端那一侧另发 `ErrorEvent`）。
 * 而共享包的归约器认的是 `error` 事件：它把 `message` 落到消息级的 `errorText`，
 * 末行因此画出 ErrorCard（带「继续 / 重跑」）。这一道翻译归宿主。
 *
 * 不翻译的后果是**整轮静默消失**，而不是「少画一张卡」：共享包 `frames.ts` 的
 * `EventDone` 分支写作 `const msg = st.turn; if (msg) {...}`，`st.turn` 只由
 * `openAssistant()` 赋值、`user_message` 分支明写 `st.turn = null`。一个助手事件都
 * 没吐的失败轮次因此 `st.turn === null`，整段是空操作——用户看到的只有自己发出去
 * 的那一条，没有报错、没有重试入口，而服务端一切正常。
 *
 * 次序不能反：`error` 分支落位后就把当前消息收掉（errorText 挂在末行，继续追加块
 * 会让错误卡漂到后来的正文之后），`done` 随后只往 `st.turn` 上补 meta。反过来则
 * meta 落到上一轮身上。
 */
export function turnDoneFrames(
  conversationId: string,
  frame: RunResultDoneFrame,
  createtime = 0,
): SessionEventFrame[] {
  const done = doneEventFrame(conversationId, frame, createtime);
  if (!isTurnFailure(frame)) return [done];
  return [
    toTranscriptFrame(
      {
        conversationId,
        event: { kind: "error", message: frame.stopErrMsg },
        seq: undefined,
      } as EventFrame,
      createtime,
    ),
    done,
  ];
}

/**
 * 这一轮是不是**故障**收场。
 *
 * 用户自己按的停止不算：它在 wire 上同样带 `stopErrMsg`（`agentruntime.ErrAborted`
 * 的文案），靠 `stopErrCode = ErrCodeAborted` 与真故障区分——不认这一格的话，每次
 * 点「停止」都会在转录里留下一张红色错误卡。
 *
 * 判据取 `stopErrMsg` 非空而不是 `stopErrCode !== 0`：有文案才画得出卡，而
 * `stopErrCode = 0` 的含义是「没有 sentinel」，不是「没出错」（见 wire.go 对
 * RunResultDoneFrame 的说明）——真正的启动失败正是这一档。
 */
function isTurnFailure(frame: RunResultDoneFrame): boolean {
  if (!frame.stopErrMsg) return false;
  return frame.stopErrCode !== ErrCodeAborted;
}
