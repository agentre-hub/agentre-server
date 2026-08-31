/**
 * 账号级实时通道在浏览器这一侧（server 的 GET /v1/account/channel）。
 *
 * 守的是规格「账号级实时通道 · 失败处理」的四条，与桌面端那一侧逐条同形
 * （agentre 的 internal/service/sync_svc/{downlink,svc}_test.go）：
 *
 *   a 收到信号立刻重拉；
 *   b 建连与每一次重连各自主动重拉一次，不等服务端补发；
 *   c **把通道整个关掉，所有功能仍然正确，只是变慢到 30 秒**，且不丢变更；
 *   d 重复、乱序、不认识的信号都无害。
 *
 * 通道**不送数据**，只送「该拉了」：因此这里的被测对象只有「什么时候重拉」，
 * 拉什么由调用方自己决定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtobufAccountChannelCodec } from "@agentre-hub/agentre-wire";

import { api } from "@/lib/api";
import {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
  accountChannelUrl,
  startAccountChannel,
  type AccountChannelHandle,
} from "@/lib/accountChannel";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

/** 假 WebSocket：由测试手动驱动 open / message / close，帧往返因此是确定性的。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws).toBeDefined();
    return ws;
  }

  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public url: string,
    public protocols: string[] = [],
  ) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(): void {
    this.closed = true;
    this.onclose?.();
  }
  close(): void {
    this.closed = true;
  }
}

const POLL_MS = 30_000;
const RECONNECT_MS = 1_000;

/**
 * 一个极小的「服务端 + 视图」模型：视图只有在被通知「该拉了」的时候才去读服务端。
 * 「不丢变更」因此可以被断言成具体的值，而不是「没崩」。
 */
function makeView() {
  const state = { onServer: "v1", inView: "" };
  return {
    state,
    /** 服务端发生了一次变更（浏览器这时还不知道）。 */
    changeOnServer(value: string) {
      state.onServer = value;
    },
    onRefresh: vi.fn(() => {
      state.inView = state.onServer;
    }),
  };
}

let handles: AccountChannelHandle[] = [];

function start(
  options: Parameters<typeof startAccountChannel>[0],
): AccountChannelHandle {
  const handle = startAccountChannel(options);
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  mockedApi.mockReset();
  mockedApi.mockResolvedValue({ access_token: "ticket-1", expires_in: 120 });
});

afterEach(() => {
  handles.forEach((h) => h.stop());
  handles = [];
  vi.useRealTimers();
});

/** 起一条通道并驱动首次建连。返回那条假连接。 */
async function connect(
  options: Partial<Parameters<typeof startAccountChannel>[0]> & {
    onRefresh: () => void;
  },
): Promise<FakeWebSocket> {
  start({
    createWebSocket: (url: string, protocols: string[]) =>
      new FakeWebSocket(url, protocols) as unknown as WebSocket,
    ...options,
  });
  // 票据是一次 await：让它落地，连接才建得起来。
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeWebSocket.last();
  ws.open();
  return ws;
}

function syncVersion(version: number): Uint8Array {
  return ProtobufAccountChannelCodec.encode({
    type: AccountChannelSyncVersion,
    version,
  });
}

describe("账号级实时通道", () => {
  it("账号信号通过共享 Protobuf codec 编成固定二进制 notification", () => {
    expect(AccountChannelSyncVersion).toBe("sync_version");
    expect(Array.from(syncVersion(9))).toEqual([
      0x0a, 0x04, 0x0a, 0x02, 0x08, 0x09,
    ]);
  });

  it("浏览器用短效票据接入，端点不指定目标 daemon", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });

    // 浏览器原生 WebSocket 设不了请求头，票据只能走 query（沿用中继那条搬运）。
    expect(mockedApi).toHaveBeenCalledWith("/v1/relay/ticket", {
      method: "POST",
    });
    expect(ws.url).toBe(accountChannelUrl("ticket-1"));
    expect(ws.url).toContain("/v1/account/channel?access_token=ticket-1");
    expect(ws.url).not.toContain("daemon_fingerprint");
    expect(ws.protocols).toEqual(["agentre-protobuf"]);
  });

  // a
  it("收到信号立刻重拉，不等 30 秒", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear(); // 建连那一次单独在下一条守

    view.changeOnServer("v2");
    ws.receive(syncVersion(42));

    expect(view.onRefresh).toHaveBeenCalledTimes(1);
    expect(view.state.inView).toBe("v2");
    // 一次定时器都没推进过：这一拉只可能是信号带来的。
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  // b
  it("建连与每一次重连都主动重拉一次，不等服务端补发", async () => {
    const view = makeView();
    const first = await connect({ onRefresh: view.onRefresh });
    expect(view.onRefresh).toHaveBeenCalledTimes(1);

    // 断线期间服务端发生了变更；通道不保存未送达的信号，补齐只能靠重连后那一拉。
    view.changeOnServer("v2");
    first.serverClose();
    // 只推进重连的等待，远不到一个轮询周期：接下来看到的那一拉不可能是轮询带来的。
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);
    second.open();

    expect(view.state.inView).toBe("v2");
    expect(view.onRefresh.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // c
  it("通道整个连不上时，功能仍然正确：退回 30 秒轮询且不丢变更", async () => {
    const view = makeView();
    let attempts = 0;
    start({
      onRefresh: view.onRefresh,
      createWebSocket: () => {
        attempts += 1;
        throw new Error("websocket unavailable");
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    // 通道死着的时候，服务端连着发生两次变更。
    view.changeOnServer("v2");
    expect(view.state.inView).toBe("");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(view.state.inView).toBe("v2");

    view.changeOnServer("v3");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(view.state.inView).toBe("v3");

    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  // c：票据都取不到（未登录 / 接口挂了）时同样只退化成轮询
  it("票据取不到时也只退回轮询", async () => {
    const view = makeView();
    mockedApi.mockRejectedValue(new Error("no session"));
    start({
      onRefresh: view.onRefresh,
      createWebSocket: (url: string, protocols: string[]) =>
        new FakeWebSocket(url, protocols) as unknown as WebSocket,
    });
    await vi.advanceTimersByTimeAsync(0);

    view.changeOnServer("v2");
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(view.state.inView).toBe("v2");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  // c 的另一半：兜底是**通道不在时**的兜底，不是无条件的心跳
  it("通道连着的时候不跑兜底轮询：没有信号就不发请求", async () => {
    const view = makeView();
    await connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear(); // 建连那一次由 b 守

    // 连着、且服务端什么都没发生：稳态下一次都不该喊「该拉了」。每喊一次，
    // 订阅到这条通道上的每个页面都会各拉一遍自己那份数据。
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(view.onRefresh).not.toHaveBeenCalled();
  });

  it("连接断了轮询就回来：兜底照旧不丢变更", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    // 断开之后重连不上（假连接构造得出来但永远不 open），退回轮询那一档。
    ws.serverClose();
    view.changeOnServer("v2");
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(view.state.inView).toBe("v2");
  });

  // d
  it("重复与乱序的信号都无害，版本号不做闸门", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    ws.receive(syncVersion(9));
    ws.receive(syncVersion(9)); // 重复
    view.changeOnServer("v2");
    ws.receive(syncVersion(3)); // 乱序：比刚见过的版本还旧

    // 三条都照常触发重拉——版本号只是「该拉了」的提示，拿它当闸门会把 v2 漏掉。
    expect(view.onRefresh).toHaveBeenCalledTimes(3);
    expect(view.state.inView).toBe("v2");
  });

  // d
  it("不认识的种类与不成形的帧都被忽略，且不弄断通道", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    ws.receive(Uint8Array.from([0x0a, 0x03, 0x98, 0x06, 0x01]));
    ws.receive(Uint8Array.from([0x0a, 0xff]));
    expect(view.onRefresh).not.toHaveBeenCalled();
    expect(ws.closed).toBe(false);

    view.changeOnServer("v2");
    ws.receive(syncVersion(1));
    expect(view.onRefresh).toHaveBeenCalledTimes(1);
    expect(view.state.inView).toBe("v2");
  });

  it("stop 之后既不重连也不再轮询", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });
    const handle = handles[handles.length - 1];

    handle.stop();
    view.onRefresh.mockClear();
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(view.onRefresh).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // `stop()` 关的是 websocket，而关闭是**异步**的：连接先进 CLOSING，onclose 要等
  // 之后才到。这中间已经在途的一帧照样会交给 onmessage —— 停掉之后不再回调这句话
  // 因此不能只靠「不再重连」来兑现（AccountChannelHandle.stop 的承诺）。
  // 调用方 stop 多半是因为自己正在拆掉：这时再喊一次「该拉了」，拉的是一个已经
  // 没人看的视图。
  it("stop 之后在途的那一帧也不再回调", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });
    const handle = handles[handles.length - 1];

    handle.stop();
    view.onRefresh.mockClear();
    view.changeOnServer("v2");
    // onclose 还没到，服务端那一帧已经在路上。
    ws.receive(syncVersion(9));

    expect(view.onRefresh).not.toHaveBeenCalled();
    // 视图停在 stop 那一刻的样子（建连时同步到的 v1），没有被在途的那一帧拖着
    // 去读 v2 —— 那正是「拉一个已经没人看的视图」的样子。
    expect(view.state.inView).toBe("v1");
  });

  // 一条连接的 onerror 与 onclose 之间隔着多久，浏览器不保证；而重连等待是调用方
  // 给的（reconnectDelayMs），给得够短时重连就可能排在旧连接的 onclose **之前**。
  // 那之后旧连接的收尾必须认出自己已经过期：它若照旧把 socket 置空，置掉的是刚
  // 换上的那一条，于是 stop() 关不到它 —— 一条没人持有、也没人关的连接就这样留在
  // 后台，继续跟着服务端的心跳活下去。
  it("旧连接的 close 不该把刚换上的那一条踢掉", async () => {
    const view = makeView();
    const first = await connect({
      onRefresh: view.onRefresh,
      reconnectDelayMs: 0,
    });
    const handle = handles[handles.length - 1];

    // 断了：排一次重连。
    first.onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);

    // 旧连接的 onclose 这时才姗姗来迟。
    first.serverClose();

    handle.stop();
    expect(second.closed).toBe(true);
  });
});

describe("账号级实时通道：多种信号", () => {
  /** 造一帧不带版本号的信号（镜像与在线态都不在同步版本序列上）。 */
  function signal(type: string): Uint8Array {
    return ProtobufAccountChannelCodec.encode({ type, version: 0 });
  }

  it("镜像变更与设备上线也是「该拉了」，默认全认", async () => {
    const view = makeView();
    const ws = await connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    view.changeOnServer("v2");
    ws.receive(signal(AccountChannelMirrorChanged));
    expect(view.state.inView).toBe("v2");

    view.changeOnServer("v3");
    ws.receive(signal(AccountChannelDevicePresence));
    expect(view.state.inView).toBe("v3");
    expect(ws.closed).toBe(false);
  });

  it("只关心某几种的调用方，别的种类到了不重拉，也不弄断通道", async () => {
    const view = makeView();
    const ws = await connect({
      onRefresh: view.onRefresh,
      signalTypes: [AccountChannelMirrorChanged],
    });
    view.onRefresh.mockClear();

    ws.receive(syncVersion(9));
    ws.receive(signal(AccountChannelDevicePresence));
    expect(view.onRefresh).not.toHaveBeenCalled();
    expect(ws.closed).toBe(false);

    ws.receive(signal(AccountChannelMirrorChanged));
    expect(view.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("收窄种类不影响建连重拉与兜底轮询：它们本来就不是按种类来的", async () => {
    const view = makeView();
    const ws = await connect({
      onRefresh: view.onRefresh,
      signalTypes: [AccountChannelMirrorChanged],
    });

    expect(view.onRefresh).toHaveBeenCalledTimes(1);

    // 轮询那一半得从**断开**跑：兜底只在通道不在时才跑（见上面「通道连着的时候
    // 不跑兜底轮询」）。断开之后它照样不看种类——收窄的是信号那一路。
    ws.serverClose();
    view.changeOnServer("v2");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(view.state.inView).toBe("v2");
  });
});
