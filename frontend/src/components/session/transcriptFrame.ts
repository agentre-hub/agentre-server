import type {
  ChatImageAttachment,
  TranscriptFrame,
  TranscriptMessage,
} from "@agentre-hub/agentre-ui";
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

/**
 * 把一帧 wire 事件帧接上共享包转录投影的形状。
 *
 * `createtime` 是这一帧**发生**的时刻（Unix 毫秒），由中继那一层按来路分好之后交进来
 * （补齐带原点报的值、实时帧就是收到的此刻，见 `NotificationHandlers.onEvent`）。
 * 它是转录里每条消息头上那个 HH:mm 的唯一来源——这一侧从帧现折转录，没有桌面端那张
 * `chat_messages` 表可读。
 *
 * 缺省 0 而不是 `Date.now()`：0 在共享包里读作「不知道」并如实不显示时间，就地补一个
 * 当下则会给一条两天前的对话盖上今天的时间。
 */
export function toTranscriptFrame(
  frame: EventFrame,
  createtime = 0,
): SessionEventFrame {
  return { ...frame, sessionId: TranscriptSessionId, createtime };
}

/**
 * 往转录后面追加几帧，号（seq）已经在里面的那几条丢掉。
 *
 * 同一段 seq 会被**两条路**各交付一遍，这不是异常而是构造使然：账号镜像那一趟 HTTP
 * 与中继的补齐各自覆盖一段，谁也管不住对方。切走再切回时尤其明显——中继客户端是池子
 * 里共用的那一个，它的游标是**客户端**的账，右栏那次重置只清得掉 `events`；游标要
 * 与这一趟的镜像末尾对齐（高了就是洞），而对齐意味着压回去，压回去就会把这一趟已经
 * 实时收到的那几帧再送一遍。
 *
 * 所以去重放在**写进转录**这一处，而不是让每条投递路径各自小心：闸门只有一道，才
 * 说得清「同一号只画一次」。没有 seq 的帧（轮次结束标记那些宿主合成的）照单收下——
 * 它们不占中继日志的号，也无从判断是不是同一条。
 */
export function appendFrames(
  prev: SessionEventFrame[],
  incoming: SessionEventFrame[],
): SessionEventFrame[] {
  if (incoming.length === 0) return prev;
  const seen = new Set<number>();
  for (const f of prev) if (f.seq !== undefined) seen.add(f.seq);
  const fresh = incoming.filter((f) => f.seq === undefined || !seen.has(f.seq));
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh];
}

/**
 * 刚发出去、转录里还没有它的那一句，摆成一条转录消息。
 *
 * 两处用它，画出来必须是**同一个气泡**：草稿页派发在飞时（`DraftPending`）与右栏
 * 换成真详情之后（`SessionDetailView` 的 `initialUserText`）。交接就发生在这两者
 * 之间 —— 形不一致的话，用户刚说完话就看见自己的气泡跳一下。
 *
 * 它不是一条真消息：不进 `events`，也不占 seq。转录一有内容它就整条让位。
 *
 * `sessionId` 由调用方给：详情那一侧要填 `TranscriptSessionId`（包里那张审批卡拿它
 * 当存在性判据），草稿那一侧还没有号可填。
 */
export function pendingUserMessage(
  text: string,
  sessionId: number,
  images?: readonly ChatImageAttachment[],
): TranscriptMessage {
  return {
    id: 1,
    sessionId,
    role: "user",
    /*
      正文在前、附件在后 —— 与两个宿主落库时的块序一致（桌面端
      `chat_svc.userBlocksForSend`、agentred `daemon.transcriptStore.StartTurn` 都是
      先 AddText 再追加附件）。这一条摆的是「还没落地的那一句」，它一落地就让位给
      转录里那一条真的；两者块序不一致的话，用户刚说完话就看见图从文字上方跳到
      下方。只贴图那一档若不摆这几块，屏幕上就是一个空气泡：用户刚贴的图连个影子
      都没有。块的形状照共享包 `ImageBlockView` 读的那一份。
    */
    blocks: [
      { type: "text", text },
      ...(images ?? []).map((image) => ({
        type: "image" as const,
        image: {
          dataUrl: image.dataUrl,
          mediaType: image.mediaType,
          name: image.name,
        },
      })),
    ],
    model: "",
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalInputTokens: 0,
    durationMs: 0,
    errorText: "",
    seq: 0,
    createtime: 0,
  };
}
