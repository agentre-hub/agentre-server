import {
  EventOutputActivity,
  EventTextDelta,
  EventThinkingDelta,
  EventToolUseStart,
} from "@agentre-hub/agentre-wire";

/**
 * 一轮跑起来之后，画那条 meta 要的四个数。
 *
 * 形状是共享包 `LiveTurnInput` 的计时那一半（另一半是 token 列与正在长的正文，
 * 它们从消息本身上取）。桌面端把同样的四个数攒在 `chat-streams-store` 上 ——
 * 那边的输入是 Go 侧的事件流，本站是中继帧，攒法各自为政，攒出来的东西必须一样：
 * 计算只有共享包 `computeLiveTurnStats` 那一份。
 */
export type LiveTurnTiming = {
  /** 这一轮什么时候开的。耗时从它起算。 */
  startedAt: number;
  /** 首字（含只报「开始产出」的纯计时信号）什么时候到的。没到时是 null。 */
  firstTokenAt: number | null;
  /** 已经收表的那些生成段合计。 */
  generationMs: number;
  /** 这一段生成什么时候开表的；停表期间（工具在跑）是 null。 */
  burstStartedAt: number | null;
};

/**
 * 开表。
 *
 * 生成时长从**开轮**起算而不是从首字起算，与桌面端同一口径：首帧回来之前那段等待
 * 也是这一轮的产出成本，把它排除掉会让 tok/s 在长思考的一轮上虚高。
 */
export function beginLiveTurn(now: number): LiveTurnTiming {
  return {
    startedAt: now,
    firstTokenAt: null,
    generationMs: 0,
    burstStartedAt: now,
  };
}

/** 记首字的三种帧。前两种是可见文字，第三种是 wire 上明写的纯计时信号。 */
const FIRST_TOKEN_KINDS: ReadonlySet<string> = new Set([
  EventTextDelta,
  EventThinkingDelta,
  EventOutputActivity,
]);

/**
 * 拿一帧推进计时。
 *
 * `timing` 为 null 时原样交回 null —— **没开表的轮次不会被一帧唤醒**。接进来时对端
 * 已经在跑就是这种情形：那一轮什么时候开的本站不知道（wire 上带 `started_at` 的只有
 * 会话级与导入用的结构），从半路起表会给出一个偏小、却看着与真的一样的数。
 *
 * 与计时无关的帧交回**同一个对象**：这份计时每来一帧都要过一次渲染，每次新建一个
 * 等于把转录行的 memo 全部作废。
 */
export function advanceLiveTurn(
  timing: LiveTurnTiming | null,
  kind: string | undefined,
  now: number,
): LiveTurnTiming | null {
  if (!timing || !kind) return timing;

  if (FIRST_TOKEN_KINDS.has(kind)) {
    // 首字只记第一次:后面每个 chunk 都改一次的话,「首字延迟」就成了「最后一字」。
    const firstTokenAt = timing.firstTokenAt ?? now;
    // 停表之后的第一段文字重新开表。
    const burstStartedAt = timing.burstStartedAt ?? now;
    if (
      firstTokenAt === timing.firstTokenAt &&
      burstStartedAt === timing.burstStartedAt
    ) {
      return timing;
    }
    return { ...timing, firstTokenAt, burstStartedAt };
  }

  // 工具在跑的那一段不算生成:tok/s 的分母是「模型在吐字的时长」,把工具执行算进去
  // 会让一轮里工具越多、速率看着越慢,而那与模型快不快无关。
  if (kind === EventToolUseStart && timing.burstStartedAt != null) {
    return {
      ...timing,
      generationMs:
        timing.generationMs + Math.max(0, now - timing.burstStartedAt),
      burstStartedAt: null,
    };
  }

  return timing;
}
