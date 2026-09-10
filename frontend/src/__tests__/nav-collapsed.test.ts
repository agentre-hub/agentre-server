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
    // 直接换掉这个实例上的方法：测试环境里的 localStorage 是 setup.ts 装的
    // 内存实现，不继承 Storage.prototype，往原型上打桩打不着。
    vi.spyOn(globalThis.localStorage, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });

    expect(readNavCollapsed()).toBe(false);
    expect(() => writeNavCollapsed(false)).not.toThrow();
  });
});
