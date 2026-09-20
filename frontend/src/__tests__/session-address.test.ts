/**
 * 会话地址（规格 2026-09-17-chat-session-url「Address contract」）：
 *   - 会话只经 `/chat/:conversationId` 寻址，未保存的会话带 `?device=`。
 *   - 索引范围参数（axis / machine …）在打开、切换、关闭会话时原样保留；`device`
 *     只属于会话寻址，`compose` 是一次性的，两者都不随范围带走。
 */
import { describe, expect, it } from "vitest";

import {
  chatIndexAddress,
  isConversationId,
  readDeviceParam,
  sessionAddress,
} from "@/lib/sessionAddress";

const CID = "01a0ae6a-4e9e-7d68-92ee-0ec6937b6db8";

describe("sessionAddress", () => {
  it("已保存的会话只有会话号", () => {
    expect(sessionAddress(CID)).toBe(`/chat/${CID}`);
  });

  it("未保存的会话带 device", () => {
    expect(sessionAddress(CID, { device: 3 })).toBe(`/chat/${CID}?device=3`);
  });

  it("保留范围参数，丢掉上一条会话的 device 与一次性的 compose", () => {
    expect(
      sessionAddress(CID, {}, "?axis=machine&machine=2&device=9&compose=1"),
    ).toBe(`/chat/${CID}?axis=machine&machine=2`);
    expect(
      sessionAddress(CID, { device: 4 }, new URLSearchParams("axis=agent")),
    ).toBe(`/chat/${CID}?axis=agent&device=4`);
  });
});

describe("chatIndexAddress", () => {
  it("没有范围参数时就是 /chat", () => {
    expect(chatIndexAddress()).toBe("/chat");
    expect(chatIndexAddress("?device=3")).toBe("/chat");
  });

  it("保留范围参数、去掉 device", () => {
    expect(chatIndexAddress("?axis=machine&machine=2&device=3")).toBe(
      "/chat?axis=machine&machine=2",
    );
  });
});

describe("readDeviceParam", () => {
  it("正整数才算", () => {
    expect(readDeviceParam(new URLSearchParams("device=12"))).toBe(12);
    expect(readDeviceParam(new URLSearchParams(""))).toBeNull();
    expect(readDeviceParam(new URLSearchParams("device=0"))).toBeNull();
    expect(readDeviceParam(new URLSearchParams("device=-1"))).toBeNull();
    expect(readDeviceParam(new URLSearchParams("device=1.5"))).toBeNull();
    expect(readDeviceParam(new URLSearchParams("device=abc"))).toBeNull();
  });
});

describe("isConversationId", () => {
  it("只认 UUID", () => {
    expect(isConversationId(CID)).toBe(true);
    expect(isConversationId(CID.toUpperCase())).toBe(true);
    expect(isConversationId("42")).toBe(false);
    expect(isConversationId("")).toBe(false);
    expect(isConversationId(`${CID}x`)).toBe(false);
  });
});
