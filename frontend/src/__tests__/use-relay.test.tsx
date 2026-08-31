/**
 * `useRelayMachine` 对外报的连接状态（`relayState`）。
 *
 * 这个 hook 做的**不止**是转发 `RelayClient.onStateChange`：连接是两步的 ——
 * 先向 `/v1/relay/ticket` 换一张短效票，拿到票才建得出 client。第一步期间还没有
 * client，因此 `relayState` 停在初值 "disconnected"。
 *
 * 而 "disconnected" 在 `deriveSessionViewStatus` 里读作「连过又放弃了」= "lost"，
 * 横幅说的是「连接断了，已经不再自动重试」。于是刷新页面后第一次打开对话，
 * 整个取票往返都在红色终态横幅底下走：那一档说的是「不会再有进展了」，可它
 * 正是最有进展的时候。
 *
 * 取票是连接的一部分，那这段时间对外就得说「连接中」。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRelayMachine } from "@/hooks/use-relay";
import { ensureRelayTicket } from "@/lib/relayTicket";

vi.mock("@/lib/relayTicket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayTicket")>();
  return { ...actual, ensureRelayTicket: vi.fn() };
});

/** 假 client：只把 onStateChange 的把手交出来，连接由用例自己驱动。 */
const fake = vi.hoisted(() => {
  const instances: { connect: () => Promise<void>; close: () => void }[] = [];
  class FakeRelayClient {
    private readonly onStateChange: (s: string) => void;
    connect = vi.fn(async () => {
      this.onStateChange("connecting");
    });
    close = vi.fn(() => {
      this.onStateChange("disconnected");
    });
    constructor(opts: { onStateChange: (s: string) => void }) {
      this.onStateChange = opts.onStateChange;
      instances.push(this);
    }
  }
  return { instances, FakeRelayClient };
});

vi.mock("@/lib/relayClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayClient")>();
  return { ...actual, RelayClient: fake.FakeRelayClient };
});

const mockedEnsureRelayTicket = vi.mocked(ensureRelayTicket);

const TICKET = {
  accessToken: "tok",
  clientId: "browser-1",
  clientName: "Chrome · macOS",
};

/** 挂起不 resolve 的取票：用来停在「票还没回来」那一帧上。 */
function pending<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  fake.instances.length = 0;
  mockedEnsureRelayTicket.mockReset();
});

describe("useRelayMachine 的连接状态", () => {
  it("还没有目标机器时不谎称在连", () => {
    const { result } = renderHook(() => useRelayMachine(null));
    expect(result.current.relayState).toBe("disconnected");
    expect(mockedEnsureRelayTicket).not.toHaveBeenCalled();
  });

  it("取票还没回来时报「连接中」,不是「已断开」", async () => {
    const gate = pending<typeof TICKET>();
    mockedEnsureRelayTicket.mockReturnValue(gate.promise);

    const { result } = renderHook(() => useRelayMachine("fp-1"));

    // 这一帧就是刷新后第一次打开对话看到的那一帧：票在路上，client 还不存在。
    expect(result.current.relayState).toBe("connecting");

    gate.resolve(TICKET);
    await waitFor(() => expect(fake.instances).toHaveLength(1));
    await waitFor(() => expect(result.current.relayState).toBe("connecting"));
  });

  it("取票失败后回到「已断开」,好让页面给出重连的出口", async () => {
    const gate = pending<typeof TICKET>();
    mockedEnsureRelayTicket.mockReturnValue(gate.promise);

    const { result } = renderHook(() => useRelayMachine("fp-1"));
    expect(result.current.relayState).toBe("connecting");

    gate.reject(new Error("boom"));
    // 取不到票就没有自动重试可言：终态说法（"lost" + 重新连接按钮）此时才成立。
    await waitFor(() => expect(result.current.relayState).toBe("disconnected"));
    expect(result.current.relayTicketError).toBeInstanceOf(Error);
  });

  it("按下重新连接时立刻回到「连接中」,而不是先退回红色终态", async () => {
    mockedEnsureRelayTicket.mockResolvedValue(TICKET);
    const { result } = renderHook(() => useRelayMachine("fp-1"));
    await waitFor(() => expect(fake.instances).toHaveLength(1));

    // 重连是「换一个 client 从取票整条重来」：旧 client 先被 close 掉,于是这里
    // 同样有一段没有 client 的时间。按下按钮后立刻退回「已经不再自动重试」,
    // 说的正好和按钮做的事相反。
    const gate = pending<typeof TICKET>();
    mockedEnsureRelayTicket.mockReturnValue(gate.promise);
    act(() => result.current.reconnect());

    expect(result.current.relayState).toBe("connecting");
  });
});
