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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtobufAccountChannelCodec } from "@agentre-hub/agentre-wire";

import {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSignalWindowMs,
  AccountChannelSyncVersion,
  startAccountChannel,
  type AccountChannelHandle,
  type AccountChannelState,
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
  /** 连接被判死，不再自动重拨（close() 过，或建连时就没起来）。 */
  disconnected(): void {
    this.onStateChange?.("disconnected");
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

/** 造一帧不带版本号的信号（镜像与在线态都不在同步版本序列上）。 */
function typedSignal(type: string): Uint8Array {
  return ProtobufAccountChannelCodec.encode({ type, version: 0 });
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
  it("重复与乱序的信号都无害，版本号不做闸门", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    fake.receive(syncVersion(9));
    fake.receive(syncVersion(9)); // 重复
    view.changeOnServer("v2");
    fake.receive(syncVersion(3)); // 乱序：比刚见过的版本还旧

    // 三条都照常算数——版本号只是「该拉了」的提示，拿它当闸门会把 v2 漏掉。
    // 首发立刻分发，后两条并进窗口结束时的那一次尾补（见「按种类分发的信号攒批」）。
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs);
    expect(view.onRefresh).toHaveBeenCalledTimes(2);
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
  it("镜像变更与设备上线也是「该拉了」，默认全认", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    view.changeOnServer("v2");
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    expect(view.state.inView).toBe("v2");

    view.changeOnServer("v3");
    fake.receive(typedSignal(AccountChannelDevicePresence));
    // 另一种落在同一个窗口里，尾补时才分发（见「按种类分发的信号攒批」）。
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs);
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
    fake.receive(typedSignal(AccountChannelDevicePresence));
    expect(view.onRefresh).not.toHaveBeenCalled();
    expect(fake.live).toBe(true);

    fake.receive(typedSignal(AccountChannelMirrorChanged));
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

/**
 * 这条通道此刻的状态（规格「账号级实时通道 · 呈现」）。
 *
 * 灯是**三态**，不是池子那四个 RelayState 的透传：`connecting` 与 `reconnecting`
 * 在用户那里是同一件事（在动、会自己回来），而 `disconnected` 与它们**不是**同一
 * 件事——它不会自己回来，界面必须给出路。
 */
describe("这条通道此刻的状态", () => {
  /** 起一路信号，把每一次状态变化按序记下来。 */
  function watch(): { fake: FakeSignalSource; states: AccountChannelState[] } {
    const fake = new FakeSignalSource();
    const states: AccountChannelState[] = [];
    start({
      source: fake.source,
      onRefresh: vi.fn(),
      onState: (state) => states.push(state),
    });
    return { fake, states };
  }

  it("连上、掉线重连、被判死，三态各说一次", () => {
    const { fake, states } = watch();

    fake.connected();
    fake.reconnecting();
    fake.connected();
    fake.disconnected();

    expect(states).toEqual([
      "connected",
      "connecting",
      "connected",
      "disconnected",
    ]);
  });

  it("同一个状态不重复说：退避期间每拨一次不该让灯闪一下", () => {
    const { fake, states } = watch();

    fake.connected();
    fake.reconnecting();
    fake.reconnecting();
    fake.reconnecting();

    expect(states).toEqual(["connected", "connecting"]);
  });

  it("首次就没连起来（只有这一路不可用，没有任何状态事件）判成已断开", () => {
    const { fake, states } = watch();

    // 池子取票失败时只调这一下（relayClientPool.subscribeSignals 的 catch），
    // 此后**没有任何东西重试**——这是唯一一个不会自愈的状态，灯必须说出来。
    fake.signalClosed();

    expect(states).toEqual(["disconnected"]);
  });

  it("连过之后的每一次断开都伴随重连，不因为那一下就说成已断开", () => {
    const { fake, states } = watch();

    fake.connected();
    // 真实顺序：RelayConnection.handleClose 先喊 onSignalClosed，再置
    // reconnecting。拿前一下判「已断开」会把一条正在自愈的连接说成死了。
    fake.signalClosed();
    fake.reconnecting();

    expect(states).toEqual(["connected", "connecting"]);
  });

  it("停掉之后不再说话：调用方多半正在拆自己", () => {
    const fake = new FakeSignalSource();
    const states: AccountChannelState[] = [];
    const handle = start({
      source: fake.source,
      onRefresh: vi.fn(),
      onState: (state) => states.push(state),
    });

    handle.stop();
    fake.connected();

    expect(states).toEqual([]);
  });
});

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const NOTIFY_GO = path.join(REPO_ROOT, "internal/service/mirror_svc/notify.go");

/**
 * 读服务端那一侧的 `mirrorChangeWindow`，换算成毫秒；写法认不出来时返回 null
 * （返回 null 会让下面那条守卫红，而不是悄悄放行）。
 */
function goMirrorChangeWindowMs(): number | null {
  const go = fs.readFileSync(NOTIFY_GO, "utf8");
  const m =
    /const\s+mirrorChangeWindow\s*=\s*(?:(\d+)\s*\*\s*)?time\.(Second|Millisecond)\b/.exec(
      go,
    );
  if (m === null) return null;
  const count = m[1] === undefined ? 1 : Number(m[1]);
  return count * (m[2] === "Second" ? 1_000 : 1);
}

/**
 * 收件侧的攒批窗口（规格「收件侧：攒批与可见性」）。
 *
 * 形状与服务端那一侧一模一样：**首发 + 尾补**。压的是「一轮对话跑着的时候同一个
 * 账号每秒被唤醒好几次」——每唤醒一次，订到这一路上的每个页面都各拉一遍自己那份
 * 数据（见 use-account-channel 的 fanOut），所以省下的不是一次回调而是一批请求。
 *
 * 只挡**按种类分发**的那一路：`refresh(null)` 是「不丢变更」的依据，进窗口等于给
 * 补齐加延迟，那条 Hard invariant 就不成立了。
 */
describe("按种类分发的信号攒批", () => {
  /**
   * 攒批窗口契约守卫（前端 ↔ internal/service/mirror_svc）。
   *
   * 两侧各自声明这个数，不跨语言共享；但它们说的是同一件事「摘要多久刷新一次算
   * 够」，写歪了总时延就变成两个常量的和，而没有任何一处代码写得出这个和。
   *
   * 所以这里不能只断言前端那个字面量是 3000 —— 那样服务端把 mirrorChangeWindow
   * 调成别的数时，这条用例照样是绿的，而它名字里说的那件事已经不成立了。手法与
   * error-code-contract / user-code-contract 相同：直接读那份 Go 源文件，把常量
   * 抠出来逐字比。
   */
  it("窗口与服务端 mirror_svc 的 mirrorChangeWindow 是同一个数", () => {
    expect(
      goMirrorChangeWindowMs(),
      "internal/service/mirror_svc 的 mirrorChangeWindow 与 AccountChannelSignalWindowMs " +
        "必须是同一个数；两边不一致时，一条变更要等两个窗口，而没有任何一处代码写得出这个和",
    ).toBe(AccountChannelSignalWindowMs);
  });

  it("窗口外的第一条立刻分发，窗口内的同种压到窗口结束才补一条", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    fake.receive(typedSignal(AccountChannelMirrorChanged));
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    // 首发不等窗口：一次突发里第一条的时延仍是零，叠加只发生在尾补上。
    expect(view.onRefresh.mock.calls).toEqual([[AccountChannelMirrorChanged]]);

    // 窗口走完之前，后面两条一条都不出去。
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs - 1);
    expect(view.onRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(view.onRefresh.mock.calls).toEqual([
      [AccountChannelMirrorChanged],
      [AccountChannelMirrorChanged],
    ]);
  });

  it("窗口结束时把攒下的种类各分发一次，不合成一条", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 首发
    fake.receive(typedSignal(AccountChannelDevicePresence));
    fake.receive(syncVersion(9));
    fake.receive(typedSignal(AccountChannelDevicePresence)); // 同种再来一次
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs);

    // 合成一条（或者补一条 null）会让只订某一种的订阅者被错误唤醒或错误跳过：
    // fanOut 是按种类过滤订阅者的，种类是它唯一的判据。
    expect(view.onRefresh.mock.calls).toEqual([
      [AccountChannelMirrorChanged],
      [AccountChannelDevicePresence],
      [AccountChannelSyncVersion],
    ]);
  });

  it("补过之后还有信号就再开一个窗口，空窗口才关掉", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 首发，开窗
    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 被压住
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs);
    expect(view.onRefresh).toHaveBeenCalledTimes(2); // 尾补

    // 尾补之后紧接着又来一条：窗口续着，它不能当成「窗口外的第一条」立刻放行，
    // 否则持续写入的账号又退回成一秒好几次。
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    expect(view.onRefresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs);
    expect(view.onRefresh).toHaveBeenCalledTimes(3);

    // 这一轮窗口里什么都没来：窗口关掉，安静下来之后的下一条又是零时延。
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs);
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    expect(view.onRefresh).toHaveBeenCalledTimes(4);
  });

  /**
   * 分发是**同步**回调调用方的，而调用方在那一下里把通道停掉是它的正常出路：
   * use-account-channel 的 fanOut 直说了「某个订阅者的 refresh 触发 setState，
   * 可能同步卸载掉别的订阅者」，卸载走到 releaseChannel 就是 stop()。
   *
   * 于是「分发完再续一个窗口」这一步会踩在一个已经停掉的通道上，把一个定时器留在
   * stop() 之后——handle 连同它闭包里那一份调用方状态被这个定时器吊着。停掉之后
   * 不该再留下任何东西，这两条各守一个续窗的来路。
   */
  it("首发里被同步 stop() 时不续窗：定时器不留在 stop() 之后", () => {
    let handle: AccountChannelHandle | null = null;
    const fake = new FakeSignalSource();
    handle = start({
      source: fake.source,
      onRefresh: () => handle?.stop(),
    });

    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 首发 → 同步 stop()

    expect(vi.getTimerCount()).toBe(0);
  });

  it("尾补里被同步 stop() 时不续窗：定时器不留在 stop() 之后", async () => {
    let handle: AccountChannelHandle | null = null;
    let stopOnNextRefresh = false;
    const fake = new FakeSignalSource();
    handle = start({
      source: fake.source,
      onRefresh: () => {
        if (stopOnNextRefresh) handle?.stop();
      },
    });

    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 首发，开窗
    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 被压住
    stopOnNextRefresh = true;
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("refresh(null) 的来路一条都不进窗口：兜底那一路不受攒批影响", async () => {
    const view = makeView();
    const fake = new FakeSignalSource();
    // 一直没连上 ⇒ 信号那一路不算通着，兜底轮询照跑；把周期调到比窗口短，
    // 才能让一次轮询正好落在开着的窗口里——这正是要守的那一刻。
    start({
      source: fake.source,
      onRefresh: view.onRefresh,
      pollIntervalMs: 1_000,
    });

    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 首发，开窗
    fake.receive(typedSignal(AccountChannelMirrorChanged)); // 被压住
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.onRefresh.mock.calls).toEqual([
      [AccountChannelMirrorChanged],
      [null], // 轮询那一条一点没等窗口
    ]);

    // 连上／重连那一条同样立刻走，窗口还开着也一样。
    fake.connected();
    expect(view.onRefresh.mock.calls).toEqual([
      [AccountChannelMirrorChanged],
      [null],
      [null],
    ]);
  });
});

/**
 * 标签页不可见时（规格决策 4/5/6）。
 *
 * 看不见的页面上没有任何人在等这份数据；而恢复可见时的那一次 `refresh(null)` 与
 * 重连时那一次是同一条补齐路径，不新增语义。判据取 `document.visibilityState` 而
 * 不是窗口焦点：失焦但可见的窗口（分屏、并排对照）用户确实在看。
 */
describe("标签页不可见时", () => {
  /** 改可见性并像浏览器那样喊一声——两件事必须同时发生，缺一不是真的切换。 */
  function setVisibility(value: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("隐藏期间按种类的信号一条都不分发", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    const idle = vi.getTimerCount(); // 此刻只剩兜底轮询那一个

    setVisibility("hidden");
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    fake.receive(syncVersion(9));

    // 连窗口都不该**开出来**。只断言「没有回调」分不出这件事：refresh 自己也认
    // 可见性，所以窗口照开着、每 3 秒醒一次、醒来什么都不分发的实现同样能让下面
    // 那条通过。后台标签页上不能留着这么一个白醒的定时器，所以这里数定时器。
    expect(vi.getTimerCount()).toBe(idle);

    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs * 2);
    expect(view.onRefresh).not.toHaveBeenCalled();
  });

  it("隐藏期间兜底轮询也停，恢复可见后回来", async () => {
    const view = makeView();
    const fake = new FakeSignalSource();
    start({ source: fake.source, onRefresh: view.onRefresh });
    fake.signalClosed(); // 信号那一路不在 ⇒ 轮询是唯一的取数来源
    view.onRefresh.mockClear();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(view.onRefresh).not.toHaveBeenCalled();

    setVisibility("visible");
    view.onRefresh.mockClear(); // 恢复可见那一次由下一条守
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(view.onRefresh.mock.calls).toEqual([[null]]);
  });

  it("恢复可见时恰好补一次 refresh(null)", () => {
    const view = makeView();
    connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    setVisibility("hidden");
    setVisibility("visible");

    // 隐藏期间可能什么都变过，也可能什么都没变——补齐路径只有这一条，
    // 与重连后那一次同形，因此它不能是按种类的，也不能是两次。
    expect(view.onRefresh.mock.calls).toEqual([[null]]);
  });

  it("恢复可见先清空窗口：补齐之后不再冒出隐藏期间攒下的尾补", async () => {
    const view = makeView();
    const fake = connect({ onRefresh: view.onRefresh });
    view.onRefresh.mockClear();

    // 窗口里还压着一条的时候被切走。
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    fake.receive(typedSignal(AccountChannelMirrorChanged));
    expect(view.onRefresh).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility("visible");
    expect(view.onRefresh.mock.calls).toEqual([
      [AccountChannelMirrorChanged],
      [null],
    ]);

    // 不清空的话，刚补齐完几百毫秒后还会再无谓地重拉一遍。
    await vi.advanceTimersByTimeAsync(AccountChannelSignalWindowMs * 2);
    expect(view.onRefresh).toHaveBeenCalledTimes(2);
  });

  it("stop() 把 visibilitychange 监听一并摘掉", () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const fake = new FakeSignalSource();
    const handle = start({ source: fake.source, onRefresh: vi.fn() });

    const registered = added.mock.calls.find(
      ([type]) => type === "visibilitychange",
    );
    expect(registered).toBeDefined();

    handle.stop();
    // 摘的必须是同一个函数：留在 document 上的监听会把整个 handle 连同它闭包里
    // 那一份调用方状态一起吊住，页面切一次就漏一份。
    expect(
      removed.mock.calls.some(
        ([type, fn]) => type === "visibilitychange" && fn === registered?.[1],
      ),
    ).toBe(true);

    added.mockRestore();
    removed.mockRestore();
  });

  it("document 不可用的环境按一直可见处理，不抛错", () => {
    // 这条通道允许自己不在，但不允许自己弄坏调用方。
    vi.stubGlobal("document", undefined);
    try {
      const view = makeView();
      const fake = connect({ onRefresh: view.onRefresh });
      view.onRefresh.mockClear();

      fake.receive(typedSignal(AccountChannelMirrorChanged));
      expect(view.onRefresh.mock.calls).toEqual([
        [AccountChannelMirrorChanged],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
