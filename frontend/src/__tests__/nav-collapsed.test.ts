import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NAV_COLLAPSED_KEY,
  readNavCollapsed,
  writeNavCollapsed,
} from "@/lib/navCollapsed";

describe("侧栏收起偏好", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("没记录过就是展开的——不需要先学会一个按钮才能用", () => {
    expect(readNavCollapsed()).toBe(false);
  });

  it("写进去读得回来，两个方向都记", () => {
    writeNavCollapsed(true);
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe("1");
    expect(readNavCollapsed()).toBe(true);

    writeNavCollapsed(false);
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe("0");
    expect(readNavCollapsed()).toBe(false);
  });

  it("值坏了按展开算，不去猜", () => {
    localStorage.setItem(NAV_COLLAPSED_KEY, "yes");
    expect(readNavCollapsed()).toBe(false);
  });

  it("localStorage 不可用时不抛——记不住不该让整个外壳崩掉", () => {
    // 先真的存过一次「收着」：不这么做的话，「返回 false」既可能是接住了异常，
    // 也可能只是因为存储本来就是空的——用例会在没有 try/catch 时照样绿。
    writeNavCollapsed(true);
    // 整个换掉 globalThis 上的 localStorage，而不是往实例上打桩。实例是什么随
    // 环境变：node 26 下是 setup.ts 装的内存实现，打得着；node 22 下 jsdom 自己
    // 那个实现还在，它是带具名属性代理的 Storage，往实例上 defineProperty 会被
    // 代理当成「存一个 key」吞掉，桩装不上、getItem 仍然解析到 Storage.prototype
    // ——这条用例因此只在新 node 上绿，CI(node 22)红。
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    const unusable = {
      getItem() {
        throw new Error("private mode");
      },
      setItem() {
        throw new Error("private mode");
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, "localStorage", {
      value: unusable,
      configurable: true,
      writable: true,
    });

    try {
      expect(readNavCollapsed()).toBe(false);
      expect(() => writeNavCollapsed(false)).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      }
    }
  });
});
