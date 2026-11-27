/**
 * 一条通道（`RelayClient`）跑在**真的**账号级连接（`RelayConnection`）上时的传输行为：
 * 假 socket + 假时钟，连接的退避、换票与通道的握手都是生产里那一份。
 *
 * 守的是 2026-11-25 弱网那一轮的 E2 / E3：
 *  - 首拨失败、之后连接恢复：通道自己开出来，不用刷新（W2）；
 *  - 页面可见时连续两次请求超时：换一条新连接，换票期间对外说「连接中」；
 *  - 取票 401：停拨，转登出态；
 *  - 单次请求可以自带等应答的上限（大图上传）。
 */
import {
  ProtobufRpcCodec,
  rpcMethods,
  unwrapEnvelope,
  wrapEnvelope,
} from "@agentre-hub/agentre-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { RelayClient, RequestTimeoutMs } from "@/lib/relayClient";
import { RelayConnection } from "@/lib/relayConnection";
import { machineTarget } from "@/lib/relayTarget";

const TARGET = machineTarget("fp-daemon");

/** 一条假 socket：按通道拆信封，记下每条通道声明的目标与发出的载荷。 */
class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  /** 通道号 → 声明的目标。 */
  readonly targets = new Map<string, string>();
  /** 通道号 → 目标声明之后发出的每一帧载荷。 */
  readonly frames = new Map<string, Uint8Array[]>();
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: unknown): void {
    const { channelId, frame } = unwrapEnvelope(data as Uint8Array);
    if (!this.targets.has(channelId)) {
      this.targets.set(channelId, new TextDecoder().decode(frame));
      this.frames.set(channelId, []);
      return;
    }
    this.frames.get(channelId)!.push(frame);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 拨号失败：还没 open 就报错并关闭。 */
  fail(): void {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(channelId: string, payload: Uint8Array): void {
    this.onmessage?.({ data: wrapEnvelope(channelId, payload) });
  }

  /** 声明了某个目标的那条通道号。 */
  channelOf(target: string): string | undefined {
    for (const [id, t] of this.targets) if (t === target) return id;
    return undefined;
  }

  /** 某条通道上某个方法的请求帧。 */
  requests(target: string, method: string) {
    const id = this.channelOf(target);
    if (!id) return [];
    return this.frames
      .get(id)!
      .map((f) => ProtobufRpcCodec.decode(f))
      .filter(
        (f) => f.body.case === "typedMethodRequest" && f.body.method === method,
      );
  }

  /** 把这条通道上最后一次 auth.account 答成成功。 */
  answerAuth(target: string): void {
    const auth = this.requests(target, "authAccount");
    const last = auth[auth.length - 1];
    expect(last, "还没有 auth.account 发出去").toBeTruthy();
    this.receive(
      this.channelOf(target)!,
      ProtobufRpcCodec.encodeTypedMethodResponse(
        last.id,
        rpcMethods.authAccount,
        { ok: true },
      ),
    );
  }
}

type Credentials = { url: string; jwt: string };

function harness(
  options: {
    credential?: () => string | Promise<string>;
    refreshCredentials?: () => Promise<Credentials>;
    onNextRetryAt?: (at: number | null) => void;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const refreshCredentials = vi.fn(
    options.refreshCredentials ??
      (() =>
        Promise.resolve({
          url: "ws://relay.test/v1/relay/client",
          jwt: "jwt-n",
        })),
  );
  const connection = new RelayConnection({
    url: "ws://relay.test/v1/relay/client",
    jwt: "jwt",
    reconnectDelayMs: 1000,
    random: () => 1,
    refreshCredentials,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const client = new RelayClient({
    connection,
    target: TARGET,
    credential: options.credential ?? (() => "tok"),
    onNextRetryAt: options.onNextRetryAt,
  });
  return { sockets, connection, client, refreshCredentials };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** 连上并握完手。 */
async function connectAndAuth(
  sockets: FakeSocket[],
  client: RelayClient,
): Promise<void> {
  const connected = client.connect();
  sockets[sockets.length - 1].open();
  await flush();
  sockets[sockets.length - 1].answerAuth(TARGET);
  await connected;
}

const setVisibility = (state: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });

/** 挂起的取票：用来停在「票还没回来」那一段。 */
function held<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

describe("首拨失败之后（E2 / W2）", () => {
  /*
    W2 的根因：connect() 先 await 连接再开通道。首拨失败时 await 抛出，通道从来没进
    连接的通道表；之后连接自己退避重连上了，它只重新声明表里那些——这一条不在里面，
    于是页面停在「连接中」，只有刷新整页才好。
  */
  it("连接之后自己恢复时，通道自动开出来并握手，不需要刷新", async () => {
    const { sockets, client } = harness();
    client.connect().catch(() => {});
    sockets[0].fail();
    await flush();
    expect(client.state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await flush();

    expect(sockets[1].channelOf(TARGET)).toBeDefined();
    sockets[1].answerAuth(TARGET);
    await flush();
    expect(client.state).toBe("connected");
  });
});

describe("通道先于连接开出来", () => {
  // 通道在连接 open 之前就进了通道表：open 那一下通道的 onOpen 与 connect() 都要握手，
  // 只能握一次。
  it("socket 开出来时只发一次 auth.account", async () => {
    const { sockets, client } = harness();
    const connected = client.connect();
    sockets[0].open();
    await flush();

    expect(sockets[0].requests(TARGET, "authAccount")).toHaveLength(1);
    sockets[0].answerAuth(TARGET);
    await connected;
    expect(client.state).toBe("connected");
  });
});

describe("单次请求的等应答上限（timeoutMs）", () => {
  // 大图上传一帧就要传很久：30 秒的默认上限会把一次正在进行的上传判成超时。
  it("带了 timeoutMs 的请求按它落定，不按默认的 30 秒", async () => {
    const { sockets, client } = harness();
    await connectAndAuth(sockets, client);

    let settled: unknown = "pending";
    const inflight = client
      .request(
        rpcMethods.sessionList,
        { conversationIds: ["c-1"] },
        { timeoutMs: 120_000 },
      )
      .catch((e: unknown) => {
        settled = e;
      });
    await vi.advanceTimersByTimeAsync(RequestTimeoutMs);
    expect(settled).toBe("pending");

    await vi.advanceTimersByTimeAsync(120_000 - RequestTimeoutMs);
    await inflight;
    expect(settled).toMatchObject({ code: -1 });
  });

  it("不带 timeoutMs 时仍是默认的 30 秒", async () => {
    const { sockets, client } = harness();
    await connectAndAuth(sockets, client);

    const inflight = client.request(rpcMethods.sessionList, {
      conversationIds: ["c-1"],
    });
    const done = expect(inflight).rejects.toMatchObject({ code: -1 });
    await vi.advanceTimersByTimeAsync(RequestTimeoutMs);
    await done;
  });
});

describe("察觉死连接（E3）", () => {
  /** 发一条请求并让它等满默认上限超时。 */
  async function timeOutOnce(client: RelayClient): Promise<void> {
    const inflight = client
      .request(rpcMethods.sessionList, { conversationIds: ["c-1"] })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(RequestTimeoutMs);
    await inflight;
  }

  it("页面可见时连续两次请求超时：换一条新连接，换票期间说「连接中」", async () => {
    const ticket = held<Credentials>();
    const { sockets, client, refreshCredentials } = harness({
      refreshCredentials: () => ticket.promise,
    });
    await connectAndAuth(sockets, client);

    await timeOutOnce(client);
    expect(refreshCredentials).not.toHaveBeenCalled();
    await timeOutOnce(client);

    // 换连接在取票：此刻对外是「连接中」，发送据此走排队。
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(client.state).toBe("connecting");

    ticket.resolve({ url: "ws://relay.test/v1/relay/client", jwt: "jwt-2" });
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await flush();
    sockets[1].answerAuth(TARGET);
    await flush();
    expect(client.state).toBe("connected");
  });

  it("两次超时之间收到过应答：不算连续，不换连接", async () => {
    const { sockets, client, refreshCredentials } = harness();
    await connectAndAuth(sockets, client);

    await timeOutOnce(client);
    // 这条 socket 还活着：它送回了一帧应答。
    const answered = client.request(rpcMethods.sessionList, {
      conversationIds: ["c-1"],
    });
    const [req] = sockets[0].requests(TARGET, "sessionList").slice(-1);
    sockets[0].receive(
      sockets[0].channelOf(TARGET)!,
      ProtobufRpcCodec.encodeTypedMethodResponse(
        req.id,
        rpcMethods.sessionList,
        {},
      ),
    );
    await answered;
    await timeOutOnce(client);

    expect(refreshCredentials).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  // 后台里定时器被节流、超时并不可信；回到前台由池子按「在后台待了多久」换连接。
  it("页面隐藏时的超时不算数", async () => {
    const { sockets, client, refreshCredentials } = harness();
    await connectAndAuth(sockets, client);

    setVisibility("hidden");
    await timeOutOnce(client);
    await timeOutOnce(client);

    expect(refreshCredentials).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });
});

describe("登出（401）与网络错误", () => {
  it("连接重拨时取票 401：通道转登出态，不再重拨", async () => {
    const { sockets, client, refreshCredentials } = harness({
      refreshCredentials: () =>
        Promise.reject(new ApiError(401, "unauthorized", 401)),
    });
    client.connect().catch(() => {});
    sockets[0].fail();
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.state).toBe("signedOut");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it("握手现取凭据 401：通道转登出态，不再重试握手", async () => {
    const credential = vi.fn(() =>
      Promise.reject(new ApiError(401, "unauthorized", 401)),
    );
    const { sockets, client } = harness({ credential });
    client.connect().catch(() => {});
    sockets[0].open();
    await flush();

    expect(client.state).toBe("signedOut");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(credential).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["502", () => new ApiError(-1, "bad gateway", 502)],
    ["网络错误", () => new TypeError("Failed to fetch")],
  ])("重拨时取票 %s：不进终态，继续退避重试", async (_name, error) => {
    const { sockets, client, refreshCredentials } = harness({
      refreshCredentials: () => Promise.reject(error()),
    });
    client.connect().catch(() => {});
    sockets[0].fail();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(client.state).toBe("reconnecting");
    expect(refreshCredentials.mock.calls.length).toBeGreaterThan(3);
  });
});

describe("下一次自动重试的时刻（nextRetryAt）", () => {
  it("连不上时交出下一次重拨的时刻，连上之后清空", async () => {
    const onNextRetryAt = vi.fn();
    const { sockets, client } = harness({ onNextRetryAt });
    client.connect().catch(() => {});
    const failedAt = Date.now();
    sockets[0].fail();
    await flush();

    // random=1、首次退避 1 秒。
    expect(client.nextRetryAt).toBe(failedAt + 1000);
    expect(onNextRetryAt).toHaveBeenLastCalledWith(failedAt + 1000);

    await vi.advanceTimersByTimeAsync(1000);
    sockets[1].open();
    await flush();
    sockets[1].answerAuth(TARGET);
    await flush();
    expect(client.nextRetryAt).toBeNull();
    expect(onNextRetryAt).toHaveBeenLastCalledWith(null);
  });

  it("socket 连着而握手失败时，交出的是握手重试的时刻", async () => {
    const { sockets, client } = harness({
      credential: () => Promise.reject(new Error("mint failed")),
    });
    client.connect().catch(() => {});
    sockets[0].open();
    await flush();

    expect(client.state).toBe("reconnecting");
    expect(client.nextRetryAt).not.toBeNull();
    expect(client.nextRetryAt!).toBeGreaterThan(Date.now());
  });
});
