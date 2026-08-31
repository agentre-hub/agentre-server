import { describe, expect, it } from "vitest";

import type { JournaledNotification } from "@agentre-hub/agentre-wire";

import { doneEventFrame } from "@/components/session/turnDone";
import { applyJournalFrames } from "@/lib/relayClient";

/**
 * 终态帧（`runtime.runResultDone`）→ 转录里的那条结束标记。
 *
 * 三条读取路径（实时推送、重连补齐、镜像回放）都要经这里，所以它自己一份用例。
 * 从前三处各写了一句 `push({ kind: "done" })`，把帧上的模型与本轮计时原地扔掉 ——
 * 于是控制台的 meta 永远是「模型 —、耗时 0.0s」，首字与速率整行不出。
 *
 * 归约那一半不在这里：帧上的字段落到哪条消息、用量怎么合并，都归共享包的
 * `frames.ts`（连同它自己的用例）。这里只负责「一个字段都不丢」。
 */
describe("doneEventFrame", () => {
  it("给定带 meta 的终态帧，当转成事件，则模型与计时原样带过去", () => {
    const frame = doneEventFrame(42, {
      sessionId: 42,
      model: "claude-sonnet-4-6",
      durationMs: 9640,
      firstTokenMs: 8010,
      tokensPerSec: 14.2,
      usage: {
        promptTokens: 14229,
        completionTokens: 102,
        cachedTokens: 13056,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
      },
    });

    expect(frame.sessionId).toBe(42);
    expect(frame.event).toMatchObject({
      kind: "done",
      model: "claude-sonnet-4-6",
      durationMs: 9640,
      firstTokenMs: 8010,
      tokensPerSec: 14.2,
      usage: { promptTokens: 14229, completionTokens: 102 },
    });
  });

  /**
   * 老 agentred 发不出这三个数。缺的字段要**不出现**，而不是补成 0 —— 共享包把 0
   * 读作「有这个数，值是 0」：`durationMs: 0` 会让 meta 栏画出一条「0.0s」，
   * 那是在替对端撒谎，而它真实的意思是「这台机器还答不出这个数」。
   */
  it("给定老 agentred 的终态帧，当转成事件，则不编出零值", () => {
    const event = doneEventFrame(42, { sessionId: 42 }).event as Record<
      string,
      unknown
    >;

    expect(event.kind).toBe("done");
    expect(event).not.toHaveProperty("model");
    expect(event).not.toHaveProperty("durationMs");
    expect(event).not.toHaveProperty("firstTokenMs");
    expect(event).not.toHaveProperty("tokensPerSec");
    expect(event).not.toHaveProperty("usage");
  });

  /** seq 留空是有意的：这条标记是宿主合成的，不占中继日志的序号。 */
  it("给定终态帧，当转成事件，则不占 seq", () => {
    expect(doneEventFrame(42, { sessionId: 42 }).seq).toBeUndefined();
  });
});

/**
 * 镜像回放这条路径多绕一道：server 把 typed 帧投影成 JSON（`wireview`，零值省略），
 * 浏览器再由 `journaledToFrame` 拼回帧形状。绕的这一道是逐字段手写的，漏一个的
 * 表现不是报错而是**静默变空** —— 历史会话的 meta 没了，实时那一轮却有。
 */
describe("镜像回放的终态帧", () => {
  it("给定镜像投影出的一页，当应用，则本轮计时一路带到事件上", () => {
    const seen: { event: Record<string, unknown> }[] = [];
    applyJournalFrames(
      [
        {
          seq: 7,
          method: "runtime.runResultDone",
          params: {
            sessionId: 42,
            model: "claude-sonnet-4-6",
            durationMs: 9640,
            firstTokenMs: 8010,
            tokensPerSec: 14.2,
          },
        } as unknown as JournaledNotification,
      ],
      {
        onRunResultDone: (frame) =>
          seen.push(
            doneEventFrame(42, frame) as unknown as {
              event: Record<string, unknown>;
            },
          ),
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].event).toMatchObject({
      kind: "done",
      model: "claude-sonnet-4-6",
      durationMs: 9640,
      firstTokenMs: 8010,
      tokensPerSec: 14.2,
    });
  });
});
