/**
 * 一轮的计时状态机。
 *
 * 计算归共享包的 `computeLiveTurnStats`（两端同一份），本站只负责**攒出它要的
 * 那四个数**：开表时刻、首字时刻、已累计的生成时长、这一段生成是什么时候开表的。
 * 桌面端把同样的四个数攒在 `chat-streams-store` 上；本站的输入是中继帧，所以攒在
 * 这里。
 */
import { describe, expect, it } from "vitest";

import {
  advanceLiveTurn,
  beginLiveTurn,
} from "@/components/session/liveTurnTiming";

const T0 = 1_756_000_000_000;

describe("advanceLiveTurn", () => {
  /**
   * 没开表就不开表：一轮的起点没观察到（接进来时对端已经在跑）时，帧再多也不能
   * 从半路给出一个「已经跑了多久」——那个数看着与真的一样，却是从接入那一刻起算的。
   */
  it("给定没开表，当来帧，则仍然不计时", () => {
    expect(advanceLiveTurn(null, "text_delta", T0)).toBeNull();
  });

  it("给定已开表，当首个文字帧到达，则记下首字时刻", () => {
    const started = beginLiveTurn(T0);

    const next = advanceLiveTurn(started, "text_delta", T0 + 1_200);

    expect(next?.firstTokenAt).toBe(T0 + 1_200);
  });

  /** 首字只记第一次：后面每个 chunk 都改一次的话，「首字延迟」就成了「最后一字」。 */
  it("给定首字已记，当又来文字帧，则首字时刻不动", () => {
    const first = advanceLiveTurn(beginLiveTurn(T0), "text_delta", T0 + 1_200)!;

    const next = advanceLiveTurn(first, "text_delta", T0 + 5_000);

    expect(next?.firstTokenAt).toBe(T0 + 1_200);
  });

  /**
   * `output_activity` 是 wire 上明写的**纯计时信号**（「只用于记首 token」）：
   * 模型开始产出不可见的输出块（工具入参就是）时只有它，此时首字其实已经来了。
   */
  it("给定已开表，当只来产出信号，则同样记首字", () => {
    const next = advanceLiveTurn(
      beginLiveTurn(T0),
      "output_activity",
      T0 + 900,
    );

    expect(next?.firstTokenAt).toBe(T0 + 900);
  });

  /**
   * 工具在跑的那一段不算生成：tok/s 的分母是「模型在吐字的时长」，把工具执行算进去
   * 会让一轮里工具越多、速率看着越慢，而那与模型快不快无关。
   */
  it("给定工具开始执行，当再来文字，则工具那一段不计入生成时长", () => {
    const started = beginLiveTurn(T0);
    const firstToken = advanceLiveTurn(started, "text_delta", T0 + 1_000)!;
    const paused = advanceLiveTurn(firstToken, "tool_use_start", T0 + 3_000)!;

    expect(paused.burstStartedAt).toBeNull();
    expect(paused.generationMs).toBe(3_000);

    const resumed = advanceLiveTurn(paused, "text_delta", T0 + 10_000)!;

    expect(resumed.burstStartedAt).toBe(T0 + 10_000);
    expect(resumed.generationMs).toBe(3_000);
  });

  /**
   * 与计时无关的帧原样交回**同一个对象**：这份计时每来一帧都要过一次渲染，
   * 每次新建一个等于把转录行的 memo 全部作废。
   */
  it("给定与计时无关的帧，当推进，则返回同一份计时", () => {
    const started = advanceLiveTurn(beginLiveTurn(T0), "text_delta", T0 + 100)!;

    expect(advanceLiveTurn(started, "usage", T0 + 200)).toBe(started);
  });
});
