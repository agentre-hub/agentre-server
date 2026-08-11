/**
 * R8 转录归约（web 前端测试接缝的通用形态）：
 *  1. text_delta 累积成一条 assistant 消息；thinking_delta 单独累积。
 *  2. user_message 落成用户消息（带来源设备名）。
 *  3. tool_use_start / tool_result 成对渲染。
 *  4. 不识别的 kind 按原始形态如实呈现（raw 块），不隐藏。
 */
import { describe, expect, it } from "vitest";

import {
  reduceEvent,
  reduceEvents,
  type TranscriptItem,
} from "@/lib/transcript";

function ev(event: unknown): { sessionId: number; event: unknown } {
  return { sessionId: 42, event };
}

describe("转录归约:R8 通用形态", () => {
  it("text_delta 累积成一条 assistant 消息", () => {
    const items = reduceEvents([
      ev({ kind: "text_delta", text: "你" }),
      ev({ kind: "text_delta", text: "好" }),
    ]);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "你好",
    });
  });

  it("user_message 落成用户消息并带来源设备名", () => {
    const items = reduceEvents([
      ev({
        kind: "user_message",
        text: "把按钮改蓝",
        sourceDevice: "fp-web-1",
        sourceDeviceName: "Chrome · macOS",
      }),
    ]);
    expect(items[0]).toMatchObject({
      kind: "message",
      role: "user",
      text: "把按钮改蓝",
      fromDevice: "Chrome · macOS",
    });
  });

  it("tool_use_start 与 tool_result 成对", () => {
    const items = reduceEvents([
      ev({
        kind: "tool_use_start",
        name: "Write",
        input: { file_path: "/a/b.ts", content: "x" },
      }),
      ev({ kind: "tool_result", content: "written", isError: false }),
    ]);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      kind: "tool",
      toolName: "Write",
      result: "written",
      resultIsError: false,
    });
    expect(items[0].toolInput).toContain("file_path");
  });

  it("error 事件落成 error 块", () => {
    const items = reduceEvents([ev({ kind: "error", message: "boom" })]);
    expect(items[0]).toMatchObject({ kind: "error", text: "boom" });
  });

  it("不识别的 kind 按原始形态如实呈现,不隐藏", () => {
    const unknown = {
      kind: "plan_updated",
      plan: { title: "重写模块", steps: ["a", "b"] },
    };
    const items = reduceEvents([ev(unknown)]);
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe("raw");
    expect(items[0].eventKind).toBe("plan_updated");
    expect(items[0].raw).toEqual(unknown);
  });

  it("ask_user_question 落成 decision 信息卡(可操作输入在 DecisionPanel)", () => {
    const items = reduceEvents([
      ev({ kind: "ask_user_question", requestId: "q1" }),
    ]);
    expect(items[0]).toMatchObject({ kind: "decision", requestId: "q1" });
  });

  it("reduceEvent 是纯函数:输入数组不被修改", () => {
    const items: TranscriptItem[] = [
      { kind: "message", role: "user", text: "hi", id: "a" },
    ];
    const out = reduceEvent(items, ev({ kind: "text_delta", text: "yo" }));
    expect(items.length).toBe(1);
    expect(out.length).toBe(2);
  });

  it("done 事件落成轮次边界", () => {
    const items = reduceEvents([
      ev({ kind: "text_delta", text: "结果" }),
      ev({ kind: "done" }),
    ]);
    expect(items[items.length - 1].kind).toBe("turnDone");
  });

  it("无 kind 的事件按原始形态呈现", () => {
    const weird = { foo: 1 };
    const items = reduceEvents([ev(weird)]);
    expect(items[0]).toMatchObject({ kind: "raw", raw: weird });
  });

  // 块 id 是 Transcript 的 React key。SessionDetail 每来一条实时帧就把整段事件流
  // 重新归约一次(useMemo 依赖 events 数组),同一条历史块必须每次都拿到同一个 id ——
  // 否则每一个 token 都会让整段转录 unmount/remount:文本选中被清掉、滚动锚点丢失、
  // 而且块数越多重建越贵。
  it("同一段前缀重复归约得到同一批块 id(React key 稳定)", () => {
    const stream = [
      ev({ kind: "user_message", text: "hi" }),
      ev({ kind: "text_delta", text: "你" }),
    ];
    const first = reduceEvents(stream);
    const second = reduceEvents([
      ...stream,
      ev({ kind: "text_delta", text: "好" }),
    ]);
    expect(second.slice(0, first.length).map((i) => i.id)).toEqual(
      first.map((i) => i.id),
    );
  });

  // 并发工具调用(一条 assistant 消息里同时起 Read 与 Grep)时,结果按 toolCallId
  // 对回它自己的那张卡。只看「最后一个还没有结果的 tool 块」会把 Read 的输出挂到
  // Grep 卡上 —— 用户读到的是张冠李戴的工具输出。
  it("并发工具调用的结果按 toolCallId 归位,不挂到最后一张卡上", () => {
    const items = reduceEvents([
      ev({ kind: "tool_use_start", id: "tc-read", name: "Read", input: {} }),
      ev({ kind: "tool_use_start", id: "tc-grep", name: "Grep", input: {} }),
      ev({ kind: "tool_result", toolCallId: "tc-read", content: "read out" }),
      ev({ kind: "tool_result", toolCallId: "tc-grep", content: "grep out" }),
    ]);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ toolName: "Read", result: "read out" });
    expect(items[1]).toMatchObject({ toolName: "Grep", result: "grep out" });
  });
});
