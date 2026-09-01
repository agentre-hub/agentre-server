/**
 * 账号级实时信号在浏览器这一侧。
 *
 * 它**没有自己的 socket** 了：`/v1/account/channel` 已经删除，信号跑在那条账号级
 * 中继连接的保留通道上（决策 13/14）。所以这一族用例的被测边界从「一条 websocket 的
 * 生命周期」换成了「池子交上来的三种事件」——连上、一帧信号、这一路不可用。
 *
 * 守的仍然是规格「账号级实时通道 · 失败处理」的四条，与桌面端那一侧逐条同形
 * （agentre 的 internal/service/sync_svc/{downlink,svc}_test.go）：
 *
 *   a 收到信号立刻重拉；
 *   b 连上与每一次重连各自主动重拉一次，不等服务端补发；
 *   c **把信号那一路整个关掉，所有功能仍然正确，只是变慢到 30 秒**，且不丢变更；
 *   d 重复、乱序、不认识的信号都无害。
 *
 * 信号**不送数据**，只送「该拉了」：因此这里的被测对象只有「什么时候重拉」，
 * 拉什么由调用方自己决定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtobufAccountChannelCodec } from "@agentre-hub/agentre-wire";

import {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
  startAccountChannel,
  type AccountChannelHandle,
  type AccountSignalSource,
} from "@/lib/accountChannel";
import type { RelayState } from "@/lib/relayConnection";

const POLL_MS = 30_000;

/**
 * 池子那一路的替身：由测试手动驱动「连上 / 断开 / 一帧信号 / 这一路不可用」。
 *
 * 它替掉的正是 `relayClientPool.subscribeSignals`，所以这里驱动的每一件事都是
 * 生产里那条保留通道真会交上来的事件。
 */
class FakeSignalSource {
  subscriptions = 0;
  unsubscribes = 0;
  private onSignal: ((payload: Uint8Array) => void) | null = null;
  private onSignalClosed: (() => void) | null = null;
  private onStateChange: ((state: RelayState) => void) | null = null;

  readonly source: AccountSignalSource = {
    subscribeSignals: (onSignal, subscriber = {}) => {
      this.subscriptions += 1;
      this.onSignal = onSignal;
      this.onSignalClosed = subscriber.onSignalClosed ?? null;
      this.onStateChange = subscriber.onStateChange ?? null;
      return () => {
        this.unsubscribes += 1;
        this.onSignal = null;
        this.onSignalClosed = null;
        this.onStateChange = null;
      };
    },
  };

  /** 那条连接连上了（首次或重连都一样）。 */
  connected(): void {
    this.onStateChange?.("connected");
  }
  /** 连接掉了，正在退避重连。 */
  reconnecting(): void {
    this.onStateChange?.("reconnecting");
  }
  /** 保留通道被判死：订阅建不起来，或信号源中途断了。 */
  signalClosed(): void {
    this.onSignalClosed?.();
  }
  receive(payload: Uint8Array): void {
    this.onSignal?.(payload);
  }
  get live(): boolean {
    return this.onSignal !== null;
  }
}

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
});

afterEach(() => {
  handles.forEach((h) => h.stop());
  handles = [];
  vi.useRealTimers();
});

/** 起一路信号并驱动首次连上。返回那个替身。 */
function connect(
  options: Partial<Parameters<typeof startAccountChannel>[0]> & {
    onRefresh: (type: string | null) => void;
  },
): FakeSignalSource {
  const fake = new FakeSignalSource();
  start({ source: fake.source, ...options });
  fake.connected();
  return fake;
}

function syncVersion(version: number): Uint8Array {
  return ProtobufAccountChannelCodec.encode({
    type: AccountChannelSyncVersion,
    version,
  });
}

describe("账号级实时信号", () => {
  it("账号信号通过共享 Protobuf codec 编成固定二进制 notification", () => {
    expect(AccountChannelSyncVersion).toBe("sync_version");
    expect(Array.from(syncVersion(9))).toEqual([
      0x0a, 0x04, 0x0a, 0x02, 0x08, 0x09,
    ]);
  });

  // 决策 13：合并的是传输。信号不再自己拨一条 socket，它订阅那条共用连接。
  it("不再单开一条 socket：信号订阅的是那条共用的账号级连接", () => {
    const view = makeView();
    const fake = new FakeSignalSource();
    const handle = start({ source: fake.source, onRefresh: view.onRefresh });

    expect(fake.subscriptions).toBe(1);
    expect(fake.live).toBe(true);

    handle.stop();
    expect(fake.unsubscribes).toBe(1);
  });

  // a
  it("收到信号立刻重拉，不等 30 秒", () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear(); // 连上那一次单独在下一条守

    view.changeOnServer("v2");
    fake.receive(syncVersion(42));

    expect(view.onRefresh).toHaveBeenCalledTimes(1);
    expect(view.state.inView).toBe("v2");
    // 一次定时器都没推进过：这一拉只可能是信号带来的。
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  // b
  it("连上与每一次重连都主动重拉一次，不等服务端补发", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    expect(view.onRefresh).toHaveBeenCalledTimes(1);

    // 断线期间服务端发生了变更；保留通道不保存未送达的信号，补齐只能靠重连后那一拉。
    view.changeOnServer("v2");
    fake.reconnecting();
    // 一次轮询周期都没到：接下来看到的那一拉不可能是轮询带来的。
    await vi.advanceTimersByTimeAsync(1_000);
    fake.connected();

    expect(view.state.inView).toBe("v2");
    expect(view.onRefresh.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // c：订阅建不起来（服务端在保留通道上回了 ChannelCodeSignalUnavailable）
  it("信号那一路建不起来时功能仍然正确：退回 30 秒轮询且不丢变更", async () => {
    const view = makeView();
    const fake = new FakeSignalSource();
    start({ source: fake.source, onRefresh: view.onRefresh });
    fake.signalClosed();

    // 信号死着的时候，服务端连着发生两次变更。
    view.changeOnServer("v2");
    expect(view.state.inView).toBe("");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(view.state.inView).toBe("v2");

    view.changeOnServer("v3");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(view.state.inView).toBe("v3");
  });

  // c 的另一半：兜底是**信号不在时**的兜底，不是无条件的心跳
  it("信号通着的时候不跑兜底轮询：没有信号就不发请求", async () => {
    const view = makeView();
    connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear(); // 连上那一次由 b 守

    // 通着、且服务端什么都没发生：稳态下一次都不该喊「该拉了」。每喊一次，
    // 订阅到这一路上的每个页面都会各拉一遍自己那份数据。
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(view.onRefresh).not.toHaveBeenCalled();
  });

  it("信号源中途断了轮询就回来：兜底照旧不丢变更", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    // 保留通道被服务端关掉（信号源没了），但整条连接照常服务 RPC。
    fake.signalClosed();
    view.changeOnServer("v2");
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(view.state.inView).toBe("v2");
  });

  // d
  it("重复与乱序的信号都无害，版本号不做闸门", () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    fake.receive(syncVersion(9));
    fake.receive(syncVersion(9)); // 重复
    view.changeOnServer("v2");
    fake.receive(syncVersion(3)); // 乱序：比刚见过的版本还旧

    // 三条都照常触发重拉——版本号只是「该拉了」的提示，拿它当闸门会把 v2 漏掉。
    expect(view.onRefresh).toHaveBeenCalledTimes(3);
    expect(view.state.inView).toBe("v2");
  });

  // d
  it("不认识的种类与不成形的帧都被忽略，且不弄断这一路", () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    fake.receive(Uint8Array.from([0x0a, 0x03, 0x98, 0x06, 0x01]));
    fake.receive(Uint8Array.from([0x0a, 0xff]));
    expect(view.onRefresh).not.toHaveBeenCalled();
    expect(fake.live).toBe(true);

    view.changeOnServer("v2");
    fake.receive(syncVersion(1));
    expect(view.onRefresh).toHaveBeenCalledTimes(1);
    expect(view.state.inView).toBe("v2");
  });

  it("stop 之后退订、也不再轮询", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    const handle = handles[handles.length - 1];

    handle.stop();
    view.onRefresh.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(view.onRefresh).not.toHaveBeenCalled();
    expect(fake.unsubscribes).toBe(1);
  });

  // 退订是异步落地的（订阅者集合是共享的，池子那边可能正在扇出这一批）。
  // 「停掉之后不再回调」这句话因此不能只靠退订来兑现：调用方 stop 多半是因为
  // 自己正在拆掉，这时再喊一次「该拉了」，拉的是一个已经没人看的视图。
  it("stop 之后在途的那一帧也不再回调", () => {
    const view = makeView();
    const fake = new FakeSignalSource();
    // 退订不摘回调：模拟池子那一侧已经在扇出这一批的情形。
    const source: AccountSignalSource = {
      subscribeSignals: (onSignal, subscriber) => {
        fake.source.subscribeSignals(onSignal, subscriber);
        return () => {};
      },
    };
    start({ source, onRefresh: view.onRefresh });
    fake.connected();
    const handle = handles[handles.length - 1];

    handle.stop();
    view.onRefresh.mockClear();
    view.changeOnServer("v2");
    fake.receive(syncVersion(9));

    expect(view.onRefresh).not.toHaveBeenCalled();
    // 视图停在 stop 那一刻的样子（连上时同步到的 v1），没有被在途的那一帧拖着
    // 去读 v2 —— 那正是「拉一个已经没人看的视图」的样子。
    expect(view.state.inView).toBe("v1");
  });
});

describe("账号级实时信号：多种种类", () => {
  /** 造一帧不带版本号的信号（镜像与在线态都不在同步版本序列上）。 */
  function signal(type: string): Uint8Array {
    return ProtobufAccountChannelCodec.encode({ type, version: 0 });
  }

  it("镜像变更与设备上线也是「该拉了」，默认全认", () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    view.changeOnServer("v2");
    fake.receive(signal(AccountChannelMirrorChanged));
    expect(view.state.inView).toBe("v2");

    view.changeOnServer("v3");
    fake.receive(signal(AccountChannelDevicePresence));
    expect(view.state.inView).toBe("v3");
    expect(fake.live).toBe(true);
  });

  it("只关心某几种的调用方，别的种类到了不重拉，也不弄断这一路", () => {
    const view = makeView();
    const fake = connect({
      onRefresh: view.onRefresh,
      signalTypes: [AccountChannelMirrorChanged],
    });
    view.onRefresh.mockClear();

    fake.receive(syncVersion(9));
    fake.receive(signal(AccountChannelDevicePresence));
    expect(view.onRefresh).not.toHaveBeenCalled();
    expect(fake.live).toBe(true);

    fake.receive(signal(AccountChannelMirrorChanged));
    expect(view.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("收窄种类不影响连上重拉与兜底轮询：它们本来就不是按种类来的", async () => {
    const view = makeView();
    const fake = connect({
      onRefresh: view.onRefresh,
      signalTypes: [AccountChannelMirrorChanged],
    });

    expect(view.onRefresh).toHaveBeenCalledTimes(1);

    // 轮询那一半得从**信号不在**跑：兜底只在这一路不在时才跑（见上面那一条）。
    // 它照样不看种类——收窄的是信号那一路。
    fake.signalClosed();
    view.changeOnServer("v2");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(view.state.inView).toBe("v2");
  });
});
