import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RedialTimer } from "@/lib/redialTimer";

describe("RedialTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("到点跑一次", () => {
    const timer = new RedialTimer();
    const run = vi.fn();

    timer.schedule(1000, run);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(run).toHaveBeenCalledTimes(1);
  });

  // 单飞：已经排着一次就不再排。断线时 onerror 与 onclose 常常一起到，各排一次
  // 的话同一次断线会拉起两条连接——其中一条从此没人持有、也没人关。
  it("已经排着时再排一次不生效", () => {
    const timer = new RedialTimer();
    const run = vi.fn();

    timer.schedule(1000, run);
    timer.schedule(50, run);
    vi.advanceTimersByTime(1000);

    expect(run).toHaveBeenCalledTimes(1);
  });

  // 跑之前先把自己清空：回调里通常又会排下一次（连不上就接着退让重试），
  // 清空晚了那一次会被自己的单飞判据吞掉，重连就此停摆。
  it("回调里可以立刻排下一次", () => {
    const timer = new RedialTimer();
    const seen: number[] = [];
    const again = () => {
      seen.push(seen.length);
      if (seen.length < 3) timer.schedule(1000, again);
    };

    timer.schedule(1000, again);
    vi.advanceTimersByTime(3000);

    expect(seen).toEqual([0, 1, 2]);
  });

  it("取消之后不再跑，且可以重新排", () => {
    const timer = new RedialTimer();
    const run = vi.fn();

    timer.schedule(1000, run);
    timer.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();

    timer.schedule(1000, run);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("没排过时取消是安全的", () => {
    expect(() => new RedialTimer().cancel()).not.toThrow();
  });

  it("pending 如实报告排没排着", () => {
    const timer = new RedialTimer();
    expect(timer.pending).toBe(false);

    timer.schedule(1000, () => {});
    expect(timer.pending).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(timer.pending).toBe(false);
  });
});
