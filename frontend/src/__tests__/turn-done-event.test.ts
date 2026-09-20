import { describe, expect, it } from "vitest";

import { reduceFrames, reduceSessionState } from "@agentre-hub/agentre-ui";
import type {
  EventFrame,
  DurableNotification,
} from "@agentre-hub/agentre-wire";

import { doneEventFrame, turnDoneFrames } from "@/components/session/turnDone";
import {
  TranscriptSessionId,
  appendFrames,
  toTranscriptFrame,
} from "@/components/session/transcriptFrame";
import { applyDurableFrames } from "@/lib/relayClient";

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

  /**
   * 派生帧带的是**来源通知**的 seq，不是它自己的号。宿主合成的 error / done /
   * context_window_updated 不占持久帧的号，但同一份终态要被三条路各交付一遍
   * （实时推送、重连补齐、账号镜像回放）；带上来源 seq，`appendFrames` 才认得出
   * 「这几帧同出一源」，重放时整批丢掉。
   */
  it("给定带 seq 的终态帧，当转成事件，则派生帧带来源通知的 seq", () => {
    expect(doneEventFrame(CID, { conversationId: CID, seq: 7 }).seq).toBe(7);
  });
});

/**
 * 镜像回放这条路径多绕一道：server 把 typed 帧投影成 JSON（`wireview`，零值省略），
 * 浏览器再由 `durableToFrame` 拼回帧形状。绕的这一道是逐字段手写的，漏一个的
 * 表现不是报错而是**静默变空** —— 历史会话的 meta 没了，实时那一轮却有。
 */
describe("镜像回放的终态帧", () => {
  it("给定镜像投影出的一页，当应用，则本轮计时一路带到事件上", () => {
    const seen: { event: Record<string, unknown> }[] = [];
    applyDurableFrames(
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
        } as unknown as DurableNotification,
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

  /**
   * 无号可判的一档：终态通知报不出自己的 seq（老 agentred / 不完整上游）。
   *
   * 派生帧的 seq 留空，交给 `appendFrames` 当「无从判断归属」照单收下 —— 补一个 0
   * 或拿别的号顶上去都会误吞，而那一整轮在屏幕上会静默消失。
   */
  it("给定报不出 seq 的终态帧，当转成事件，则派生帧都不带 seq", () => {
    const normal = turnDoneFrames(CID, { conversationId: CID, model: "m" });
    const failed = turnDoneFrames(CID, {
      conversationId: CID,
      stopErrMsg: "boom",
    });
    const zero = turnDoneFrames(CID, {
      conversationId: CID,
      seq: 0,
      stopErrMsg: "boom",
    });

    expect(normal.map((f) => f.seq)).toEqual([undefined]);
    expect(failed.map((f) => f.seq)).toEqual([undefined, undefined]);
    // seq 0 是 proto3 的零值，与缺省同义；补一个 0 进事件里没有意义。
    expect(zero.map((f) => f.seq)).toEqual([undefined, undefined]);
  });

  /** 派生帧共享的是**来源通知**的 seq：同一份终态，整批都带着同一个号。 */
  it("给定带 seq 的出错终态帧，当转成事件，则两条共享来源 seq", () => {
    const frames = turnDoneFrames(CID, {
      conversationId: CID,
      seq: 7,
      stopErrMsg: "boom",
    });

    expect(frames.map((f) => f.seq)).toEqual([7, 7]);
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

/**
 * 回归（用户报的现象）：出错的一轮在控制台上画出**两条**助手消息，同一句报错显示两次。
 *
 * 前一格（「只有用户消息与出错终态帧」）的一轮是在对端**启动就失败**的，事件流里
 * 一条助手事件都没有。真正跑起来之后才失败的那一轮不是这样：runtime 自己就 emit 了
 * `agentruntime.ErrorEvent`（openclaw `activeTurn.finish`、piagent `drainStream` 都是
 * 「`result.StopErr = stopErr` 之后再 `out <- ErrorEvent{Err: stopErr}`」），
 * 而 agentred 的 fanout 把事件流**原样**转发（`handlers/runtime.go` 那个 `for ev := range ch`
 * 不认 ErrorEvent，`protowire` 有 `error` 分支）—— 所以事件流里已经有一条 `error` 了，
 * 终态帧上的 `stopErrMsg` 说的是**同一件事**。
 *
 * 于是共享包收到两条 `error`：第一条落 errorText 并 `st.open = null`，第二条
 * `openAssistant()` 见 `st.open` 已空，**新起一条助手消息**再落一次 errorText。
 */
describe("回归：事件流里已经有 error 的失败轮次", () => {
  it("给定事件流已带 error、终态帧又带同一句 stopErrMsg，当归约，则只有一条助手消息", () => {
    const stopErr = "openclaw: gateway: 402 insufficient credits";
    const msgs = reduceFrames(
      [
        toTranscriptFrame(
          {
            conversationId: CID,
            event: { kind: "user_message", text: "看看目录" },
          } as unknown as EventFrame,
          1788408834659,
        ),
        toTranscriptFrame(
          {
            conversationId: CID,
            event: { kind: "text_delta", text: "我先看一下" },
          } as unknown as EventFrame,
          1788408834700,
        ),
        // runtime 自己 emit 的那一条，agentred 原样转发过来。
        toTranscriptFrame(
          {
            conversationId: CID,
            event: { kind: "error", message: stopErr },
          } as unknown as EventFrame,
          1788408834740,
        ),
        ...turnDoneFrames(
          CID,
          { conversationId: CID, stopErrMsg: stopErr, durationMs: 83 },
          1788408834743,
        ),
      ],
      TranscriptSessionId,
    );

    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].errorText).toBe(stopErr);
    // meta 也得落在这条上，而不是被第二条空消息接走。
    expect(msgs[1].durationMs).toBe(83);
  });
});

/**
 * 上下文窗口的正源在 agentred，而它只走**预览帧**：agentred 做宿主时 fanout 把每
 * 条 runtime 事件都当预览帧扇出（`Preview: true`），预览帧不带 seq、不入库、不参与
 * 补齐。于是 `context_window_updated` 一刷新就没了，底栏那条进度条永远没有分母。
 *
 * 终态帧是这条路上唯一带号的载体，它本来就有 `contextWindow` 这一格（wire 的
 * `RunResultDoneFrame.ContextWindow` → `wireview.doneView`），中继也一路解出来了 ——
 * 此前只是没人读。翻成共享包认得的那条 `context_window_updated` 事件由宿主来做，
 * 与上面把 `stopErrMsg` 翻成 `error` 是同一道工序、同一个理由。
 *
 * 为什么翻成独立一条而不是挂在 `done` 上：共享包的 `reduceSessionState` 只认
 * `context_window_updated` 与 `usage.contextWindow` 两格，`done` 上那一格它根本不看
 * （加一格就是改共享包，两端都得跟着动）。而这条事件在转录里是 silent 的，多出来
 * 的一帧一个像素都不画。
 */
describe("终态帧带来的上下文窗口", () => {
  it("给定带 contextWindow 的终态帧，当转成事件，则多出一条 context_window_updated", () => {
    const frames = turnDoneFrames(CID, {
      conversationId: CID,
      contextWindow: 400000,
    } as never);

    expect(frames.map((f) => (f.event as { kind: string }).kind)).toEqual([
      "context_window_updated",
      "done",
    ]);
    expect(frames[0].event).toMatchObject({
      kind: "context_window_updated",
      tokens: 400000,
    });
  });

  it("给定不报窗口的终态帧，当转成事件，则不编出一条 tokens 为 0 的帧", () => {
    const frames = turnDoneFrames(CID, { conversationId: CID } as never);

    expect(frames.map((f) => (f.event as { kind: string }).kind)).toEqual([
      "done",
    ]);
  });

  it("给定出错收场又带窗口的终态帧，当转成事件，则窗口排在 error 之前", () => {
    const frames = turnDoneFrames(CID, {
      conversationId: CID,
      contextWindow: 200000,
      stopErrMsg: "boom",
    } as never);

    // error → done 的先后是有讲究的（见 turnDoneFrames 的说明），窗口那一条只能
    // 排在它们**之前**，不能插进中间。
    expect(frames.map((f) => (f.event as { kind: string }).kind)).toEqual([
      "context_window_updated",
      "error",
      "done",
    ]);
  });

  it("给定带窗口的终态帧，当归约会话状态，则窗口进得了那一格", () => {
    const frames = turnDoneFrames(CID, {
      conversationId: CID,
      contextWindow: 400000,
    } as never);

    expect(reduceSessionState(frames).contextWindow).toBe(400000);
  });
});

/**
 * 归约器对「同一终态批次紧接着来两遍」是幂等的：`done` 只往当前轮的助手消息上补数
 * （空轮次是空操作），`error` 落 `st.turn` 而不是新起一条（见共享包 frames.ts）。
 *
 * 但这幂等有个前提 —— 两遍之间没有 `user_message`：它会把 `st.turn` 清空，第二遍的
 * `error` 于是会在新轮次开头另起一条只有错误卡的助手消息。所以归约器兜不住宿主那
 * 一层的重放（游标压回后补齐把事件帧与终态一起重放），那道闸门是 `appendFrames`：
 * 同一份终态派生的多帧带着来源通知的 seq（见 turnDone），同一批整批留下、重放整批
 * 丢掉。这一条钉的是前提成立那一半，免得日后有人把宿主那道闸门当成可删的冗余。
 */
describe("同一终态批次重复归约", () => {
  it("给定同一批终态帧、中间没有用户消息，当归约，则仍只有一条助手消息", () => {
    const batch = turnDoneFrames(CID, {
      conversationId: CID,
      stopErrMsg: "boom",
      durationMs: 83,
    });

    const msgs = reduceFrames(
      [
        toTranscriptFrame(
          {
            conversationId: CID,
            event: { kind: "text_delta", text: "先看一下" },
          } as unknown as EventFrame,
          1,
        ),
        ...batch,
        ...batch,
      ],
      TranscriptSessionId,
    );

    expect(msgs).toHaveLength(1);
    expect(msgs[0].errorText).toBe("boom");
    expect(msgs[0].durationMs).toBe(83);
  });

  it("给定两批之间夹一条用户消息，当归约，则出错的那批会另起一条助手消息", () => {
    // 这是前提不成立的那一档，也是宿主必须自己挡重放的原因：两批之间一夹用户消息，
    // 第二遍的 error 就落到新轮次上 —— 屏幕上两张错误卡。
    const batch = turnDoneFrames(CID, {
      conversationId: CID,
      stopErrMsg: "boom",
    });

    const msgs = reduceFrames(
      [
        toTranscriptFrame(
          {
            conversationId: CID,
            event: { kind: "text_delta", text: "第一轮" },
          } as unknown as EventFrame,
          1,
        ),
        ...batch,
        toTranscriptFrame(
          {
            conversationId: CID,
            event: { kind: "user_message", text: "第二轮" },
          } as unknown as EventFrame,
          2,
        ),
        ...batch,
      ],
      TranscriptSessionId,
    );

    expect(msgs.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    // 两条都带 errorText：这正是用户可见的「双错误卡」，宿主的 seq 闸门就是为了
    // 在重放时不让第二遍发生。
    expect(msgs[0].errorText).toBe("boom");
    expect(msgs[2].errorText).toBe("boom");
  });
});

/**
 * 派生帧带来源 seq 之后，`appendFrames` 就是终态去重的唯一一道闸门。
 *
 * 同一个终态派生的多帧**共享同一个号**，而 `appendFrames` 只用 prev 的 seen 集合
 * 过滤 incoming —— 因此同一批一起来时 context / error / done 整批通过，下一次相同
 * 批次再一起来时整批被拦。这一条同时钉住「共享 seq 不会被逐帧去重截成半批」：那
 * 正是把 error 或 context_window_updated 单独吞掉的错法（前者是错误卡凭空消失，
 * 后者是底栏进度条永远没有分母）。
 */
describe("appendFrames：同一终态派生的共享 seq 批次", () => {
  /** context → error → done 三条，共用来源终态的 seq。 */
  const failedBatch = (seq: number) =>
    turnDoneFrames(CID, {
      conversationId: CID,
      seq,
      contextWindow: 400000,
      stopErrMsg: "boom",
    });

  it("给定一批共享 seq 的派生帧，当首次追加，则整批留下", () => {
    const batch = failedBatch(7);

    expect(batch.map((f) => f.seq)).toEqual([7, 7, 7]);
    expect(appendFrames([], batch)).toHaveLength(3);
  });

  it("给定同一批共享 seq 的派生帧，当重放，则整批丢掉", () => {
    const batch = failedBatch(7);
    const first = appendFrames([], batch);

    const replay = appendFrames(first, batch);

    // 一帧都不多画：appendFrames 原样交回上一步的数组。
    expect(replay).toBe(first);
    expect(replay).toHaveLength(3);
  });

  it("给定报不出 seq 的派生帧，当重复追加，则每次都照单收下", () => {
    const batch = turnDoneFrames(CID, {
      conversationId: CID,
      contextWindow: 400000,
      stopErrMsg: "boom",
    });
    const first = appendFrames([], batch);

    const replay = appendFrames(first, batch);

    // 无号可判时不当成重放：误吞整轮收场比多画一张卡更严重。
    expect(replay).toHaveLength(6);
  });

  it("给定共享 seq 的一批与后续事件帧，当追加，则批次与后续都留下", () => {
    const first = appendFrames([], failedBatch(7));

    const next = appendFrames(first, [
      toTranscriptFrame(
        {
          conversationId: CID,
          event: { kind: "user_message", text: "再来一轮" },
          seq: 8,
        } as unknown as EventFrame,
        2,
      ),
    ]);

    expect(next).toHaveLength(4);
    expect(next[3].seq).toBe(8);
  });
});
