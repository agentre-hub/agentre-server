/**
 * 账号级连接（`RelayConnection`）自己的重拨纪律：假 socket + 假时钟。
 *
 * 守的是 2026-11-25 弱网那一轮的 E1 / E3 里归连接管的那几条：
 *  - 超时、断开、5xx 等网络错误永不进终态，持续退避重试；终态只留给 401；
 *  - 换连接（reconnect）取票期间状态即为「连接中」；取票 401 停止重拨、转登出态；
 *  - 下一次自动重拨的时刻交得出来，「立即重试」从头算起。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rpcMethods } from "@agentre-hub/agentre-wire";

import { ApiError, ApiTimeoutError } from "@/lib/api";
import { RelayClient, type UploadProgress } from "@/lib/relayClient";
import { classifySendFailure } from "@/lib/sessionView";
import {
  RelayConnection,
  isSignedOutError,
  type RelayChannelListener,
} from "@/lib/relayConnection";

class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  closed = false;
  /** 交给 send() 而还没交给网络的字节（与浏览器同一语义：关闭后不清零）。 */
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: Uint8Array): void {
    this.bufferedAmount += data.byteLength;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  fail(): void {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

type Credentials = { url: string; jwt: string };
const CREDS: Credentials = { url: "ws://relay.test/v1/relay/client", jwt: "j" };

function harness(refresh?: () => Promise<Credentials>) {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const refreshCredentials = vi.fn(refresh ?? (() => Promise.resolve(CREDS)));
  const connection = new RelayConnection({
    url: CREDS.url,
    jwt: "jwt",
    reconnectDelayMs: 1000,
    random: () => 1,
    refreshCredentials,
    onStateChange: (s) => states.push(s),
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { sockets, states, connection, refreshCredentials };
}

const unauthorized = () => new ApiError(401, "unauthorized", 401);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("登出判据", () => {
  it("只有 401 才算登出：5xx、超时、网络错误都不算", () => {
    expect(isSignedOutError(unauthorized())).toBe(true);
    expect(isSignedOutError(new ApiError(-1, "bad gateway", 502))).toBe(false);
    expect(isSignedOutError(new ApiError(403, "forbidden", 403))).toBe(false);
    expect(
      isSignedOutError(new ApiTimeoutError("/v1/relay/ticket", 15_000)),
    ).toBe(false);
    expect(isSignedOutError(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("重拨取票", () => {
  it("取票 401：转登出态并停拨，之后再久也不拨", async () => {
    const { sockets, states, connection, refreshCredentials } = harness(() =>
      Promise.reject(unauthorized()),
    );
    connection.connect().catch(() => {});
    sockets[0].fail();
    await vi.advanceTimersByTimeAsync(1000);

    expect(connection.state).toBe("signedOut");
    expect(connection.nextRetryAt).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(states).not.toContain("disconnected");
  });

  it.each([
    ["502", () => new ApiError(-1, "bad gateway", 502)],
    ["超时", () => new ApiTimeoutError("/v1/relay/ticket", 15_000)],
    ["网络错误", () => new TypeError("Failed to fetch")],
  ])("取票 %s：永不进终态，持续退避重试", async (_name, error) => {
    const { sockets, states, connection, refreshCredentials } = harness(() =>
      Promise.reject(error()),
    );
    connection.connect().catch(() => {});
    sockets[0].fail();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(connection.state).toBe("reconnecting");
    expect(connection.nextRetryAt).not.toBeNull();
    expect(refreshCredentials.mock.calls.length).toBeGreaterThan(3);
    expect(states).not.toContain("disconnected");
  });

  it("登出之后新的通道来要连接：不再拿旧票拨号", async () => {
    const { sockets, connection } = harness(() =>
      Promise.reject(unauthorized()),
    );
    connection.connect().catch(() => {});
    sockets[0].fail();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.state).toBe("signedOut");

    await expect(connection.connect()).rejects.toThrow();
    expect(sockets).toHaveLength(1);
  });
});

describe("换连接（reconnect）", () => {
  async function connected() {
    const h = harness();
    const ready = h.connection.connect();
    h.sockets[0].open();
    await ready;
    return h;
  }

  it("取票期间状态即为「连接中」", async () => {
    let release!: (c: Credentials) => void;
    const h = harness(
      () =>
        new Promise<Credentials>((resolve) => {
          release = resolve;
        }),
    );
    const ready = h.connection.connect();
    h.sockets[0].open();
    await ready;
    const listener: RelayChannelListener = { onConnectionState: vi.fn() };
    h.connection.openChannel("machine:fp", listener);

    const replacing = h.connection.reconnect();
    expect(h.connection.state).toBe("connecting");
    expect(listener.onConnectionState).toHaveBeenLastCalledWith("connecting");

    release(CREDS);
    await flush();
    h.sockets[1].open();
    await replacing;
    expect(h.connection.state).toBe("connected");
  });

  it("取票 401：转登出态，不留重拨", async () => {
    const h = await connected();
    h.refreshCredentials.mockImplementation(() =>
      Promise.reject(unauthorized()),
    );

    await expect(h.connection.reconnect()).rejects.toThrow();
    expect(h.connection.state).toBe("signedOut");
    expect(h.connection.nextRetryAt).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.refreshCredentials).toHaveBeenCalledTimes(1);
  });

  it("取票网络错误：不停在「连接中」，回到退避重试并交出下一次的时刻", async () => {
    const h = await connected();
    h.refreshCredentials.mockImplementationOnce(() =>
      Promise.reject(new ApiError(-1, "bad gateway", 502)),
    );

    await expect(h.connection.reconnect()).rejects.toThrow();
    expect(h.connection.state).toBe("reconnecting");
    expect(h.connection.nextRetryAt).toBe(Date.now() + 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets).toHaveLength(2);
  });

  // 「立即重试」：不等排着的那次，倒计时从头算。
  it("退避中立即重试：马上重拨，排着的那次作废", async () => {
    const h = harness();
    h.connection.connect().catch(() => {});
    h.sockets[0].fail();
    await flush();
    h.sockets.length = 0;
    // 攒出一段长退避。
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(h.connection.nextRetryAt! - Date.now());
      h.sockets[h.sockets.length - 1].fail();
      await flush();
    }
    expect(h.connection.nextRetryAt! - Date.now()).toBeGreaterThanOrEqual(
      16_000,
    );
    const dialed = h.sockets.length;

    void h.connection.reconnect().catch(() => {});
    await flush();
    expect(h.sockets).toHaveLength(dialed + 1);
    expect(h.connection.nextRetryAt).toBeNull();

    // 新这一条也没拨通：从最短那一档重新退避。
    h.sockets[h.sockets.length - 1].fail();
    await flush();
    expect(h.connection.nextRetryAt).toBe(Date.now() + 1000);
  });
});

describe("下一次自动重拨的时刻", () => {
  it("排上重拨时告诉每条通道，重拨开始后清空", async () => {
    const h = harness();
    const listener: RelayChannelListener = { onNextRetryAt: vi.fn() };
    h.connection.openChannel("machine:fp", listener);
    h.connection.connect().catch(() => {});
    const failedAt = Date.now();
    h.sockets[0].fail();
    await flush();

    expect(h.connection.nextRetryAt).toBe(failedAt + 1000);
    expect(listener.onNextRetryAt).toHaveBeenLastCalledWith(failedAt + 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.connection.nextRetryAt).toBeNull();
    expect(listener.onNextRetryAt).toHaveBeenLastCalledWith(null);
  });
});

/*
  lie-fi：拨号既不 open 也不 close。不能永远停在「连接中」、也不给下一次重试的时刻
  （E1「持续退避重试」「下次自动重试 N 秒后」）：拨号等满上限即按一次拨号失败退避。
*/
describe("拨号悬着不回", () => {
  it("等满上限判这次拨号失败：报重连中与下一次时刻，到点再拨", async () => {
    const h = harness();
    const listener: RelayChannelListener = { onNextRetryAt: vi.fn() };
    h.connection.openChannel("machine:fp", listener);
    h.connection.connect().catch(() => {});
    await flush();
    expect(h.connection.state).toBe("connecting");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.sockets[0].closed).toBe(true);
    expect(h.connection.state).toBe("reconnecting");
    expect(h.connection.nextRetryAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(h.sockets).toHaveLength(2);
  });

  it("上限内连上了：不误判", async () => {
    const h = harness();
    h.connection.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    h.sockets[0].open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.connection.state).toBe("connected");
    expect(h.sockets).toHaveLength(1);
  });
});

/*
  大图上传（规格 2026-11-25 决策 C4）：进度来自 socket 的 bufferedAmount 排空；中途意外
  断开、而这一帧还有字节没交给网络 = 对端不可能收到整帧，确定「还没发出去」。
*/
describe("socket 上还没发出去的字节", () => {
  async function connected() {
    const h = harness();
    const ready = h.connection.connect();
    h.sockets[0].open();
    await ready;
    return h;
  }

  it("bufferedAmount 读当前 socket 的；没有 socket 时为 0", async () => {
    const h = harness();
    expect(h.connection.bufferedAmount).toBe(0);
    const ready = h.connection.connect();
    h.sockets[0].open();
    await ready;
    h.sockets[0].bufferedAmount = 1234;
    expect(h.connection.bufferedAmount).toBe(1234);
  });

  it("socket 自己断了：仍报那些永远发不出去的字节；换连接（主动顶替）时报 0", async () => {
    const h = await connected();
    h.sockets[0].bufferedAmount = 500;
    h.sockets[0].fail();
    expect(h.connection.bufferedAmount).toBe(500);

    // 重拨出来的新 socket 接管之后读新的。
    await vi.advanceTimersByTimeAsync(0);
    h.sockets[1].open();
    await flush();
    expect(h.connection.bufferedAmount).toBe(0);

    // 主动顶替：旧 socket 关闭时浏览器仍会先发完已排队的，说不出「没发出去」。
    h.sockets[1].bufferedAmount = 700;
    void h.connection.reconnect();
    expect(h.connection.bufferedAmount).toBe(0);
  });
});

describe("请求的上传进度（RelayClient over RelayConnection）", () => {
  async function client() {
    const h = harness();
    const c = new RelayClient({
      connection: h.connection,
      target: "machine:fp",
      credential: () => "tok",
    });
    void c.connect().catch(() => {});
    h.sockets[0].open();
    await flush();
    // 握手那几帧不算这一条的：从干净的缓冲开始。
    h.sockets[0].bufferedAmount = 0;
    return { ...h, c, socket: h.sockets[0] };
  }

  function bigRun(c: RelayClient, onUpload: (p: UploadProgress) => void) {
    return c.request(
      rpcMethods.runtimeRun,
      { conversationId: "c1", userText: "x".repeat(10_000) },
      { onUpload },
    );
  }

  it("进度随缓冲排空推进，排空即报满", async () => {
    const { c, socket } = await client();
    const seen: UploadProgress[] = [];
    void bigRun(c, (p) => seen.push(p)).catch(() => {});
    const total = socket.bufferedAmount;
    expect(total).toBeGreaterThan(10_000);
    expect(seen.at(-1)).toEqual({ sent: 0, total });

    socket.bufferedAmount = total - 4000;
    await vi.advanceTimersByTimeAsync(200);
    expect(seen.at(-1)).toEqual({ sent: 4000, total });

    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(200);
    expect(seen.at(-1)).toEqual({ sent: total, total });
  });

  it("中途意外断开：这一帧没发完 → 确定没送到（notSent，重发是干净的）", async () => {
    const { c, socket } = await client();
    const result = bigRun(c, () => {}).catch((err: unknown) => err);
    socket.bufferedAmount -= 100; // 还剩一截没交给网络
    socket.fail();
    const err = await result;
    expect(classifySendFailure(err).kind).toBe("notSent");
  });

  it("整帧都交给网络之后才断：可能已送达（transport），不说没送到", async () => {
    const { c, socket } = await client();
    const result = bigRun(c, () => {}).catch((err: unknown) => err);
    socket.bufferedAmount = 0;
    socket.fail();
    expect(classifySendFailure(await result).kind).toBe("transport");
  });

  it("这一帧之后又排进别的帧、断开时只剩后来那些：这一帧已经出门，不算没送到", async () => {
    const { c, socket } = await client();
    const result = bigRun(c, () => {}).catch((err: unknown) => err);
    // 之后又有一条小请求排进来；断开时剩下的正好是它那几个字节。
    const before = socket.bufferedAmount;
    void c.request(rpcMethods.sessionList, {}).catch(() => {});
    const laterBytes = socket.bufferedAmount - before;
    expect(laterBytes).toBeGreaterThan(1);
    socket.bufferedAmount = laterBytes - 1; // 只剩后来那条里的一部分
    socket.fail();
    expect(classifySendFailure(await result).kind).toBe("transport");
  });

  it("换连接（主动顶替）时这一帧还没发完：说不出没送到，归 transport", async () => {
    const { c, socket, connection } = await client();
    const result = bigRun(c, () => {}).catch((err: unknown) => err);
    socket.bufferedAmount -= 100;
    void connection.reconnect().catch(() => {});
    expect(classifySendFailure(await result).kind).toBe("transport");
  });
});
