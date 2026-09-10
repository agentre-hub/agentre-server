import { afterEach, describe, expect, it, vi } from "vitest";

import { isConversationId, newConversationId } from "@/lib/conversationId";

/**
 * `conversation_id` 在浏览器这一侧的铸法（决策 1）。
 *
 * 号由**发起端**在建档那一刻铸——浏览器发起的对话就在这里铸。这一族守的是三件事：
 * 版本位真的是 7（不是 `crypto.randomUUID()` 的 v4）、同一毫秒连着铸不撞、
 * 写法是规范形式（它要当路由键与三套库的主键用）。
 */
afterEach(() => {
  vi.useRealTimers();
});

describe("newConversationId", () => {
  it("铸出来的是规范形式的 UUIDv7", () => {
    for (let i = 0; i < 20; i++) {
      const id = newConversationId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(isConversationId(id)).toBe(true);
    }
  });

  /*
    同一毫秒内连发。

    这不是假想：`importPorts.ts` 的批量导入就是在一个循环里连着要号。v7 的低位
    取自 CSPRNG（74 位随机），所以同一毫秒里也无需任何协调。
  */
  it("同一毫秒内连发 5000 个互不相同", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(newConversationId());
    expect(ids.size).toBe(5000);
  });

  /*
    前 48 位是 Unix 毫秒。这一条断言的是**布局**而不只是「不重复」——后者 v4 也
    能靠概率蒙过去，测不出这次铸的到底是哪一版。布局对了，「索引里天然近似有序」
    才成立，那正是选 v7 而不是 v4 的理由。
  */
  it("高 48 位就是 Unix 毫秒", () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-01T12:34:56.789Z");
    vi.setSystemTime(now);
    const id = newConversationId();
    const hex = id.replace(/-/g, "").slice(0, 12);
    expect(parseInt(hex, 16)).toBe(now.getTime());
  });

  it("晚铸的号排在前面那些之后", () => {
    vi.useFakeTimers();
    const base = new Date("2026-09-01T00:00:00Z").getTime();
    let previous = "";
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(new Date(base + i * 1000));
      const id = newConversationId();
      expect(id > previous).toBe(true);
      previous = id;
    }
  });

  // 非安全上下文（http 部署）里 `crypto.randomUUID` 根本不存在——这条路径不能依赖它。
  it("没有 crypto.randomUUID 的环境里照样铸得出来", () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: (buffer: Uint8Array) =>
        realCrypto.getRandomValues(buffer),
    });
    try {
      expect(typeof crypto.randomUUID).toBe("undefined");
      expect(isConversationId(newConversationId())).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isConversationId", () => {
  it("只认规范形式：大写、花括号、无连字符与全零一律不算", () => {
    const id = "0198f1a2-3b4c-7d5e-8f60-112233445566";
    expect(isConversationId(id)).toBe(true);
    expect(isConversationId(id.toUpperCase())).toBe(false);
    expect(isConversationId(`{${id}}`)).toBe(false);
    expect(isConversationId(id.replace(/-/g, ""))).toBe(false);
    expect(isConversationId("00000000-0000-0000-0000-000000000000")).toBe(
      false,
    );
    expect(isConversationId("9001")).toBe(false);
  });
});

// Given 这个运行环境取不到 CSPRNG，Then 铸号当场失败，而不是悄悄换成 Math.random。
//
// 铸出来的值是四张镜像表的主键，唯一性全靠那 74 位随机——没有发号器可以复核。用一个
// 可预测的 PRNG 顶上，只会在没人看得见的环境里把「不需要协调」这个前提换掉。
it("没有 crypto.getRandomValues 时如实失败，不退回可预测的随机源", () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    value: undefined,
    configurable: true,
  });
  try {
    expect(() => newConversationId()).toThrow(/getRandomValues/);
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: original,
      configurable: true,
    });
  }
});
