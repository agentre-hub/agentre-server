import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lazyPage, warmPages } from "@/lib/lazyPage";

/**
 * 造一页「还没到」的模块：`open()` 之前 `load()` 挂着不解析，用来把「模块在路上」
 * 那一帧摆到断言底下 —— 首次从别的页切到 /chat 时用户看到的空屏就是这一帧。
 */
function deferredPage(text: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const load = vi.fn(async () => {
    await gate;
    return { default: () => <div>{text}</div> };
  });
  return { load, open };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("lazyPage", () => {
  it("预热过的页首帧就有内容：不再先空一帧再补上", async () => {
    const { load, open } = deferredPage("chat page");
    const Page = lazyPage(load);

    const warmed = Page.preload();
    open();
    await warmed;

    render(<Page />);
    // 同步断言，不用 findBy*：要证的正是「第一帧就不是空的」。
    expect(screen.getByText("chat page")).toBeTruthy();
  });

  it("预热与随后的渲染共用同一份模块，不重复取", async () => {
    const { load, open } = deferredPage("chat page");
    const Page = lazyPage(load);

    open();
    await Page.preload();
    await Page.preload();
    render(<Page />);

    expect(screen.getByText("chat page")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("warmPages", () => {
  it("不在当帧取：排到浏览器的空闲回调里，让当前页的取数先跑", () => {
    let idle!: () => void;
    const requestIdleCallback = vi.fn((cb: () => void) => {
      idle = cb;
      return 7;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    const page = { preload: vi.fn().mockResolvedValue(undefined) };

    warmPages([page]);
    expect(page.preload).not.toHaveBeenCalled();

    idle();
    expect(page.preload).toHaveBeenCalledTimes(1);
  });

  it("没有 requestIdleCallback 时退回定时器（Safari 16.4 以下、以及 jsdom）", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const page = { preload: vi.fn().mockResolvedValue(undefined) };

    warmPages([page]);
    expect(page.preload).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(page.preload).toHaveBeenCalledTimes(1);
  });

  it("退订会撤掉还没跑的空闲回调：卸载之后不再预热", () => {
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn(() => 7),
    );
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const page = { preload: vi.fn().mockResolvedValue(undefined) };

    warmPages([page])();

    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    expect(page.preload).not.toHaveBeenCalled();
  });
});
