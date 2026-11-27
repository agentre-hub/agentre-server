/**
 * 「恢复信号」（规格 2026-11-25 K3）：网络恢复（`online`）、回前台、执行端通道重连之后，
 * 处在失败态的读各自自动重试一次。
 *
 *   - 一个共享来源（`@/lib/recoverySignal`）：DOM 上只挂一份监听，通道重连由连接那一侧
 *     报进来；页面藏在后台时不喊（转为可见那一下会喊）。
 *   - 每个读用 `useRetryOnRecovery(失败, 重试)` 接上：只在失败时重试；几条信号一起来
 *     只重试一次；401 不重试（登出那一路照旧）。
 */
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as accountChannel from "@/lib/accountChannel";
import type { AccountChannelState } from "@/lib/accountChannel";
import { useRetryOnRecovery } from "@/hooks/use-retry-on-recovery";
import { useAccountChannelState } from "@/hooks/use-account-channel";
import { ApiError } from "@/lib/api";
import { noteRecovery, subscribeRecovery } from "@/lib/recoverySignal";

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedStart = vi.mocked(accountChannel.startAccountChannel);

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function goOnline() {
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
}

function comeToForeground() {
  visibility = "visible";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("recoverySignal", () => {
  it("online、回前台、通道重连都喊订阅者", () => {
    const heard = vi.fn();
    const off = subscribeRecovery(heard);

    goOnline();
    comeToForeground();
    act(() => noteRecovery());

    expect(heard).toHaveBeenCalledTimes(3);
    off();
  });

  it("页面在后台时不喊：转到前台那一下才算", () => {
    const heard = vi.fn();
    const off = subscribeRecovery(heard);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    goOnline();
    act(() => noteRecovery());
    expect(heard).not.toHaveBeenCalled();

    comeToForeground();
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it("退订之后不再喊", () => {
    const heard = vi.fn();
    subscribeRecovery(heard)();
    goOnline();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("useRetryOnRecovery", () => {
  it("失败着：恢复信号来了重试一次", () => {
    const retry = vi.fn();
    renderHook(() => useRetryOnRecovery(new Error("offline"), retry));

    goOnline();

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("没有失败：信号来了什么都不做", () => {
    const retry = vi.fn();
    renderHook(() => useRetryOnRecovery(null, retry));

    goOnline();
    comeToForeground();
    act(() => noteRecovery());

    expect(retry).not.toHaveBeenCalled();
  });

  it("几条信号一起来（联网 + 回前台 + 通道重连）只重试一次", () => {
    const retry = vi.fn();
    renderHook(() => useRetryOnRecovery(true, retry));

    goOnline();
    comeToForeground();
    act(() => noteRecovery());

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("不打转：重试又失败了，不自己再试，下一次信号才再试一次", () => {
    const retry = vi.fn();
    const { rerender } = renderHook(
      ({ failure }: { failure: unknown }) => useRetryOnRecovery(failure, retry),
      { initialProps: { failure: new Error("offline") as unknown } },
    );

    goOnline();
    expect(retry).toHaveBeenCalledTimes(1);

    rerender({ failure: new Error("still offline") });
    expect(retry).toHaveBeenCalledTimes(1);

    goOnline();
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("重试还没答时又来信号：不重发同一个请求", () => {
    const retry = vi.fn();
    renderHook(() => useRetryOnRecovery(new Error("offline"), retry));

    goOnline();
    comeToForeground();
    act(() => noteRecovery());

    expect(retry).toHaveBeenCalledTimes(1);
  });

  /*
    回前台那一下网络常常还没回来：重试当场就失败（离线时 fetch 立刻拒绝），紧接着
    `online` 才到。那一下才是真的能成的时机，不能因为离上一次重试不到两秒就吞掉。
  */
  it("重试当场又失败、紧接着网络才回来：这一下照样再试", () => {
    const retry = vi.fn();
    const { rerender } = renderHook(
      ({ failure }: { failure: unknown }) => useRetryOnRecovery(failure, retry),
      { initialProps: { failure: new Error("offline") as unknown } },
    );

    comeToForeground();
    expect(retry).toHaveBeenCalledTimes(1);
    rerender({ failure: new Error("still offline") });

    goOnline();
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("401 不重试：登出那一路照旧（清空并去登录页）", () => {
    const retry = vi.fn();
    renderHook(() =>
      useRetryOnRecovery(new ApiError(30004, "未登录", 401), retry),
    );

    goOnline();

    expect(retry).not.toHaveBeenCalled();
  });

  it("喊的是最新的失败态与重试：已经恢复了就不再重试", () => {
    const retry = vi.fn();
    const { rerender } = renderHook(
      ({ failure }: { failure: unknown }) => useRetryOnRecovery(failure, retry),
      { initialProps: { failure: new Error("offline") as unknown } },
    );
    rerender({ failure: null });

    goOnline();

    expect(retry).not.toHaveBeenCalled();
  });
});

describe("执行端通道重连是恢复信号", () => {
  function Lamp() {
    useAccountChannelState();
    return null;
  }

  it("账号通道从断开回到「已连接」时喊一次；一直连着的不喊", () => {
    const heard = vi.fn();
    const off = subscribeRecovery(heard);
    render(<Lamp />);
    const onState = mockedStart.mock.calls.at(-1)![0].onState!;
    const move = (state: AccountChannelState) => act(() => onState(state));

    move("connected");
    heard.mockClear();
    move("connected");
    expect(heard).not.toHaveBeenCalled();

    move("connecting");
    move("connected");
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });
});
