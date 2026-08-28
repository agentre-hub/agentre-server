import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useAliveEffect, useApiQuery } from "@/hooks/use-api-query";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

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

describe("useApiQuery", () => {
  // 花括号不能省：mockReset() 返回的是 mock 本身（一个函数），箭头直接返回它
  // 会被 vitest 当成 teardown 回调，在每个用例后**调用**一次——那次调用没人接
  // 它的拒绝，于是变成一条未处理拒绝，报在毫不相干的用例头上。
  beforeEach(() => {
    mockedApi.mockReset();
  });

  it("取到就落 data 并结束 loading", async () => {
    mockedApi.mockResolvedValue({ n: 1 });

    const { result } = renderHook(() => useApiQuery<{ n: number }>("/v1/x"));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ n: 1 });
    expect(result.current.error).toBeNull();
  });

  it("失败落 error，loading 照样结束", async () => {
    const boom = new Error("nope");
    mockedApi.mockImplementation(() => Promise.reject(boom));

    const { result } = renderHook(() => useApiQuery<{ n: number }>("/v1/x"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(boom);
    expect(result.current.data).toBeNull();
  });

  // 失败时 error 必须是**真值**：调用方一律按 `error ? 错误态 : 骨架` 渲染，
  // 而 reject(undefined) 是存在的（一个空的 catch、一次 abort）。原样存进去的话
  // 那种失败会让页面永远停在骨架上。三个调用点此前各自写了 `e ?? new Error(...)`
  // 来兜这件事，现在兜在这里。
  it("拒绝值是假值时也给出一个真值 error", async () => {
    mockedApi.mockImplementation(() => Promise.reject(undefined));

    const { result } = renderHook(() => useApiQuery<{ n: number }>("/v1/x"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeTruthy();
    expect(String(result.current.error)).toContain("/v1/x");
  });

  // path 为 null 表示「这次不该取」（条件取数）：不发请求，也不停在 loading 上
  // 转圈——否则条件不满足的页面会永远显示骨架。
  it("path 为 null 时不发请求且不是 loading", () => {
    const { result } = renderHook(() => useApiQuery<{ n: number }>(null));

    expect(mockedApi).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  // 调用方常常要就地改这份数据（删掉一行、乐观插入），因此 setData 是导出的：
  // 否则每个调用方都得再复制一份 useState 把它抄进去。
  it("setData 可以就地改这份数据", async () => {
    mockedApi.mockResolvedValue({ n: 1 });

    const { result } = renderHook(() => useApiQuery<{ n: number }>("/v1/x"));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));

    await waitFor(() => {
      result.current.setData({ n: 2 });
      expect(result.current.data).toEqual({ n: 2 });
    });
  });

  it("卸载之后不写状态", async () => {
    const gate = pending<{ n: number }>();
    mockedApi.mockReturnValue(gate.promise);
    const onError = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(onError);

    const { unmount } = renderHook(() => useApiQuery<{ n: number }>("/v1/x"));
    unmount();
    gate.resolve({ n: 1 });
    await gate.promise;

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
