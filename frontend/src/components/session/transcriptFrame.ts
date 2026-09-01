import type { TranscriptFrame } from "@agentre-hub/agentre-ui";
import type { EventFrame } from "@agentre-hub/agentre-wire";

/**
 * 转录投影那一格 `sessionId` 的取值。
 *
 * 共享包 `@agentre-hub/agentre-ui` 的 `TranscriptFrame` / `reduceFrames` /
 * `createTranscriptProjector` 仍按旧身份收一个 `sessionId: number`——那是会话号还是
 * 各端本地自增时留下的一列。本站的对话身份已经是 `conversation_id`（决策 1），
 * 而共享包只把这个数**原样盖在**它产出的消息上、自己从不比较它，所以这里一律填
 * 同一个常量。包那一侧的重键在另一轮里做（它归 agentre 仓）。
 *
 * **不能填 0**：包里那张审批卡把它当「有没有会话」的存在性判据
 * （`tool-permission/card.tsx` 的 `if (!payload || !payload.requestId || !sessionId)
 * return;`），0 会让「允许一次」这颗按钮点下去什么都不发生，而工具还阻塞在那台
 * 机器上。取 1：本宿主从不读回它，只要是个真值就行。
 */
export const TranscriptSessionId = 1;

/** 详情页手里的一帧：wire 的事件帧 + 共享包转录投影认得的那一格。 */
export type SessionEventFrame = EventFrame & TranscriptFrame;

/** 把一帧 wire 事件帧接上共享包转录投影的形状。 */
export function toTranscriptFrame(frame: EventFrame): SessionEventFrame {
  return { ...frame, sessionId: TranscriptSessionId };
}
