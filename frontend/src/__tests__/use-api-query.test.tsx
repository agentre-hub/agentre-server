import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAliveEffect } from "@/hooks/use-api-query";

/** 挂起不 resolve 的请求：用来制造「组件先卸载、响应后到」这一幕。 */
function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useAliveEffect", () => {
  it("卸载之后 alive() 为 false，回调据此不再写状态", async () => {
    const seen: boolean[] = [];
    const gate = pending<void>();

    const { unmount } = renderHook(() =>
      useAliveEffect((alive) => {
        void gate.promise.then(() => seen.push(alive()));
      }, []),
    );

    unmount();
    gate.resolve();
    await waitFor(() => expect(seen).toEqual([false]));
  });

  it("还挂着的时候 alive() 为 true", async () => {
    const seen: boolean[] = [];
    const gate = pending<void>();

    renderHook(() =>
      useAliveEffect((alive) => {
        void gate.promise.then(() => seen.push(alive()));
      }, []),
    );

    gate.resolve();
    await waitFor(() => expect(seen).toEqual([true]));
  });

  // 依赖变化会重跑：上一轮的 alive() 必须立刻变 false，否则一次慢响应会把已经
  // 过期的那一轮结果盖到新一轮上（取数竞态）。
  it("依赖变化后上一轮的 alive() 变 false", async () => {
    const seen: Array<[number, boolean]> = [];
    const gates = [pending<void>(), pending<void>()];

    const { rerender } = renderHook(
      ({ round }: { round: number }) =>
        useAliveEffect(
          (alive) => {
            void gates[round].promise.then(() => seen.push([round, alive()]));
          },
          [round],
        ),
      { initialProps: { round: 0 } },
    );

    rerender({ round: 1 });
    gates[0].resolve();
    gates[1].resolve();

    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toContainEqual([0, false]);
    expect(seen).toContainEqual([1, true]);
  });

  it("回调返回的清理函数照常在卸载时跑", () => {
    const cleanup = vi.fn();
    const { unmount } = renderHook(() => useAliveEffect(() => cleanup, []));

    unmount();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
