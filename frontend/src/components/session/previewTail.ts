import type { SessionEventFrame } from "@/components/session/transcriptFrame";

/**
 * 预览尾巴：这一刻还没有定稿、只用于逐 token 呈现的那几帧。
 *
 * ## 为什么需要它
 *
 * 协议 0.2.0 把帧分成两级。**预览帧**是逐片段增量（`text_delta` / `thinking_delta`）
 * 与过场状态，不带 seq、不入日志、丢失即丢失；**持久帧**是块级的，带 seq，参与补齐
 * 与镜像。同一段正文因此到达两次 —— 而持久文本块投影出来的判别值同样是 `text_delta`、
 * 载荷是**整段**文本，共享包的归约器对它一律追加。两级都喂进去就是把同一段话渲染
 * 两遍（桌面端实测出的 `"onetwoonetwothreefourfive"`）。
 *
 * 桌面端的解法是「轮内只呈现预览、只落库持久」，前端拿到的是整条消息快照的**替换**
 * （`chat_svc.applyPreview` 用一个用完即弃的累加器，持久那一路配 `discardEmitter`
 * 只累积不呈现）。控制台是追加式归约，照抄不了，所以换一种等价的形状：
 *
 *   渲染 = `reduceFrames([...持久帧, ...预览尾巴])`
 *
 * ## 清空的判据
 *
 * **任何持久帧到达就清空尾巴。** 依据是 agentred 的发布时机：它在块**落库之后当场**
 * 取号并发布持久帧，所以下一块的第一个 token 不会早于上一块的持久帧到达 —— 尾巴里
 * 攒着的永远只是「最后一个持久帧之后、尚未定稿」的那一段，被持久帧覆盖的部分同一刻
 * 就该消失。补齐送来的成批持久帧走的也是这一条，不必单开一路。
 *
 * 判据取 `preview` 那一格，不取 seq：消费方把「seq 不大于游标」当重复丢弃，而预览帧
 * 本就不带 seq（见 wire.proto 上 RuntimeEventNotification 的注释）。
 */
export function nextPreviewTail(
  tail: readonly SessionEventFrame[],
  preview: boolean,
  frame?: SessionEventFrame,
): SessionEventFrame[] {
  // 已经是空的就原样交还：调用方按引用相等判要不要重渲染，每个持久帧都换一个新空数组
  // 等于让整条转录跟着重画。
  if (!preview || frame === undefined)
    return tail.length === 0 ? (tail as SessionEventFrame[]) : [];
  return [...tail, frame];
}
