import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { lazyPage, warmPages } from "@/lib/lazyPage";

/**
 * 造一页「还没到」的模块：`open()` 之前 `load()` 挂着不解析，用来把「模块在路上」
 * 那一帧摆到断言底下 —— 首次从别的页切到 /chat 时用户看到的空屏就是这一帧。
 */
/**
 * 记下这一段里冒出来的未处理拒绝。预热是「白赚的」那一路：它失败不该惊动任何人，
 * 更不该在测试跑完、环境拆掉之后才炸出来污染整轮 vitest 的退出码。
 */
function watchUnhandledRejections() {
  const seen: unknown[] = [];
  const record = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", record);
  onTestFinished(() => {
    process.off("unhandledRejection", record);
  });
  // 未处理拒绝要等这一轮微任务跑完才判定，所以断言前得让出一个宏任务。
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return seen;
  };
}

/** 造一页永远取不到的模块：线上是网络抖动或刚好撞上换版本，chunk 请求直接失败。 */
function failingPage() {
  const load = vi
    .fn<() => Promise<{ default: () => React.JSX.Element }>>()
    .mockRejectedValue(
      new Error("failed to fetch dynamically imported module"),
    );
  return { load };
}

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

  it("取模块失败不留在缓存里：下一次重新发起，一次抖动不会把这页钉死在空屏", async () => {
    const load = failingPage().load;
    const Page = lazyPage(load);

    await Page.preload();
    load.mockResolvedValue({ default: () => <div>chat page</div> });
    await Page.preload();

    render(<Page />);
    expect(screen.getByText("chat page")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("预热取不到不报错：白赚的那一路不该冒出未处理拒绝", async () => {
    const settled = watchUnhandledRejections();
    const Page = lazyPage(failingPage().load);

    await expect(Page.preload()).resolves.toBeUndefined();

    expect(await settled()).toEqual([]);
  });

  it("渲染时取模块失败只留空页：不冒泡成未处理拒绝", async () => {
    const settled = watchUnhandledRejections();
    const Page = lazyPage(failingPage().load);

    render(<Page />);

    expect(await settled()).toEqual([]);
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
