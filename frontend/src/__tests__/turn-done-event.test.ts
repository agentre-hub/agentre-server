import { describe, expect, it } from "vitest";

import { reduceFrames } from "@agentre-hub/agentre-ui";
import type {
  EventFrame,
  JournaledNotification,
} from "@agentre-hub/agentre-wire";

import { doneEventFrame, turnDoneFrames } from "@/components/session/turnDone";
import {
  TranscriptSessionId,
  toTranscriptFrame,
} from "@/components/session/transcriptFrame";
import { applyJournalFrames } from "@/lib/relayClient";

const CID = "11111111-1111-7111-8111-111111111111";

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
    const frame = doneEventFrame(CID, {
      conversationId: CID,
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

    expect(frame.conversationId).toBe(CID);
    // 共享包的转录投影那一格恒为常量（见 transcriptFrame）。
    expect(frame.sessionId).toBe(TranscriptSessionId);
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
    const event = doneEventFrame(CID, { conversationId: CID }).event as Record<
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
    expect(doneEventFrame(CID, { conversationId: CID }).seq).toBeUndefined();
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
            conversationId: CID,
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
            doneEventFrame(CID, frame) as unknown as {
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

/**
 * 一轮**出错**收场时，转录里要看得见「为什么没有回复」。
 *
 * 停止原因在 wire 上只挂在终态帧的 `stopErrMsg` / `stopErrCode` 上（事件流里没有
 * 对应的 kind —— `agentruntime.Done` 那四格里根本没有错误位）。而共享包的归约器
 * 认的是 `error` 事件：它把 `message` 落到消息级的 `errorText`，末行因此画出
 * ErrorCard（带「继续 / 重跑」）。两者之间这一道翻译归宿主，就是这里。
 *
 * 不翻译的后果是**整轮静默消失**：`EventDone` 那个分支写作
 * `const msg = st.turn; if (msg) {...}`，而 `st.turn` 只由 `openAssistant()` 赋值、
 * `user_message` 分支明写 `st.turn = null`。一个助手事件都没吐的失败轮次因此
 * `st.turn === null`，整段是空操作 —— 用户看到的就只有自己发出去的那一条，
 * 没有报错、没有灰条、没有重试入口，而服务端一切正常。
 */
describe("turnDoneFrames：出错收场的那一轮", () => {
  it("给定带 stopErrMsg 的终态帧，当转成事件，则先出一条 error 事件再出 done", () => {
    const frames = turnDoneFrames(CID, {
      conversationId: CID,
      stopErrMsg: "claudecode: exit 1: --dangerously-skip-permissions ...",
      durationMs: 83,
    });

    expect(frames).toHaveLength(2);
    expect(frames[0].event).toMatchObject({
      kind: "error",
      message: "claudecode: exit 1: --dangerously-skip-permissions ...",
    });
    // 次序不能反：共享包的 error 分支落位后就把消息收掉（errorText 挂末行），
    // done 随后只补 meta。反过来则 meta 落到上一轮身上。
    expect(frames[1].event).toMatchObject({ kind: "done", durationMs: 83 });
  });

  /**
   * 用户自己按的停止**不是**错误。它在 wire 上同样带 `stopErrMsg`
   * （`agentruntime.ErrAborted` 的文案，见 daemon 的 runtime_test），靠
   * `stopErrCode = -32013`（`wire.ErrCodeAborted`）与真故障区分。
   * 不认这一格的话，每次点「停止」都会在转录里留下一张红色错误卡。
   */
  it("给定用户中断（stopErrCode 为 aborted）的终态帧，当转成事件，则不画错误卡", () => {
    const frames = turnDoneFrames(CID, {
      conversationId: CID,
      stopErrMsg: "aborted by user",
      stopErrCode: -32013,
    });

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toMatchObject({ kind: "done" });
  });

  it("给定正常收场的终态帧，当转成事件，则只有 done 一条", () => {
    const frames = turnDoneFrames(CID, { conversationId: CID, model: "m" });

    expect(frames).toHaveLength(1);
    expect(frames[0].event).toMatchObject({ kind: "done" });
  });

  /** 合成帧不占中继日志的序号，两条都一样。 */
  it("给定出错的终态帧，当转成事件，则两条都不占 seq", () => {
    const frames = turnDoneFrames(CID, {
      conversationId: CID,
      stopErrMsg: "boom",
    });

    expect(frames.map((f) => f.seq)).toEqual([undefined, undefined]);
  });

  /** 时刻取终态帧那一刻：错误卡与它补的 meta 属于同一轮，不该差出一个时间。 */
  it("给定出错的终态帧，当转成事件，则两条共用终态帧的时刻", () => {
    const frames = turnDoneFrames(
      CID,
      { conversationId: CID, stopErrMsg: "boom" },
      1788408834743,
    );

    expect(frames.map((f) => f.createtime)).toEqual([
      1788408834743, 1788408834743,
    ]);
  });
});

/**
 * 端到端的那一格：这是用户报的现象本身 —— 「我发起对话，只有发送的内容，没有回复」。
 * 一轮在对端启动就失败（`eventKinds={UserMessage:1}`、`hasStopError=true`），
 * 归约完必须有一条助手消息带着 errorText，而不是只剩用户那一条。
 */
describe("失败轮次的归约结果", () => {
  it("给定只有用户消息与出错终态帧的一轮，当归约，则出一条带 errorText 的助手消息", () => {
    const msgs = reduceFrames(
      [
        toTranscriptFrame(
          {
            conversationId: CID,
            event: { kind: "user_message", text: "看看目录" },
          } as unknown as EventFrame,
          1788408834659,
        ),
        ...turnDoneFrames(
          CID,
          {
            conversationId: CID,
            stopErrMsg:
              "agentruntime/runtimes/claudecode: subprocess produced no events (likely exited on startup)",
            durationMs: 83,
          },
          1788408834743,
        ),
      ],
      TranscriptSessionId,
    );

    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].errorText).toBe(
      "agentruntime/runtimes/claudecode: subprocess produced no events (likely exited on startup)",
    );
    // 出错的那一轮同样要有 meta：这恰恰是最需要看耗时的时候。
    expect(msgs[1].durationMs).toBe(83);
  });
});
