import { EventTextDelta, EventThinkingDelta } from "@agentre-hub/agentre-wire";

import type { SessionEventFrame } from "@/components/session/transcriptFrame";

/**
 * 预览尾巴：这一刻还没有定稿、只用于逐 token 呈现的那几帧。
 *
 * ## 为什么需要它
 *
 * 协议 0.2.0 把帧分成两级。**预览帧**按 wire 的定义是逐片段增量（`text_delta` /
 * `thinking_delta`）与过场状态，不带 seq、不入转录、丢失即丢失（实际来的还不止这些，
 * 见下面「进得来的只有逐 token 增量」）；**持久帧**是块级的，带 seq，参与补齐
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
 *
 * ## 进得来的只有逐 token 增量
 *
 * 上面那条清空规则**只对逐 token 增量成立**，而 agentred 对块级事件同样发两份。
 * 块级事件的预览副本落在**它自己的持久帧之后**（dev 环境抓包：`seq=4` 的
 * `tool_permission_request` 先到，1ms 后同一个 `requestId` 的预览副本再到），
 * 轮次就此停在那条审批上 —— 再没有持久帧来清尾巴。于是那一帧永远留在投影里，
 * 而共享包的归约器对 `tool_permission_request` 是无条件 push 新块：屏幕上两张
 * 一模一样的审批卡，刷新一下才剩一张。
 *
 * 所以尾巴改成**白名单**：只收真正的逐 token 增量，别的预览帧一律原样放过。
 */

/**
 * 逐 token 增量的全集。
 *
 * 取这两个而不是更多，依据是 wire 自己的定义（`RuntimeEventNotification` 上那段
 * 注释）：预览帧是「逐片段增量（text_delta、thinking_delta）或过场状态（retry、
 * runtime_status）」—— 逐片段增量就这两个，其余都不是。
 *
 * 过场状态与 `output_activity` 刻意不在名单里：这条尾巴的**唯一**去处是转录投影
 * （`framesForProjection`），而共享包的归约器对 retry / runtime_status /
 * output_activity 本来就一个字都不产出（`frames.ts` 里它们与
 * `context_window_updated` 同列在「不进正文」那一档）。收进来只是让数组白长一截。
 * 计时那一路不受影响 —— 它吃的是 `noteFrameArrived`，与这条尾巴无关。
 *
 * 白名单而不是黑名单：认不出的预览帧默认**不进**投影。两边的错法不对称 ——
 * 漏放一个增量，那一段字晚几百毫秒才出现（下一个持久帧一到就补齐）；错放一个块级
 * 帧，屏幕上就多出一张永不消失的重复卡片。日后 wire 新增的 kind 几乎必然是块级的。
 */
const INCREMENTAL_PREVIEW_KINDS: ReadonlySet<string> = new Set([
  EventTextDelta,
  EventThinkingDelta,
]);

export function nextPreviewTail(
  tail: readonly SessionEventFrame[],
  preview: boolean,
  frame?: SessionEventFrame,
): SessionEventFrame[] {
  // 已经是空的就原样交还：调用方按引用相等判要不要重渲染，每个持久帧都换一个新空数组
  // 等于让整条转录跟着重画。
  if (!preview || frame === undefined)
    return tail.length === 0 ? (tail as SessionEventFrame[]) : [];
  const kind = (frame.event as { kind?: string } | undefined)?.kind;
  // 不是逐 token 增量：原样交还同一个数组（理由同上，别让转录白重画一遍）。
  if (kind === undefined || !INCREMENTAL_PREVIEW_KINDS.has(kind))
    return tail as SessionEventFrame[];
  return [...tail, frame];
}
