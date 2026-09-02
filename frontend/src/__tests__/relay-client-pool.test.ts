import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RelayClient, RelayClientOptions } from "@/lib/relayClient";
import { RelayClientPool } from "@/lib/relayClientPool";
import type { RelayConnection } from "@/lib/relayConnection";
import { machineTarget } from "@/lib/relayTarget";
import type { RelayTicket } from "@/lib/relayTicket";

/**
 * 池子的行为规格。这里**不**碰真的 WebSocket：池子的职责是「一个账号一条连接、
 * 一个目标一条通道、谁都不许替别人关掉它」，与帧怎么编解码无关（那是
 * relay-client-protobuf 那一份用例的事）。所以连接与客户端整个被替成能数出
 * 「建了几条、关了几条」的替身。
 *
 * socket 总数那一条单独住在 relay-socket-count 里——它是本轮的目标数字。
 */
class FakeConnection {
  closed = 0;
  connects = 0;
  reconnects = 0;
  state = "connecting";
  constructor(readonly opts: unknown) {}
  connect(): Promise<void> {
    this.connects++;
    return Promise.resolve();
  }
  async reconnect(): Promise<void> {
    this.reconnects++;
  }
  close(): void {
    this.closed++;
  }
  subscribeSignals(): () => void {
    return () => {};
  }
}

class FakeClient {
  closed = 0;
  connects = 0;
  reopens = 0;
  connectResult: Promise<void> = Promise.resolve();
  constructor(readonly opts: RelayClientOptions) {}
  connect(): Promise<void> {
    this.connects++;
    return this.connectResult;
  }
  reopen(): Promise<void> {
    this.reopens++;
    return Promise.resolve();
  }
  close(): void {
    this.closed++;
  }
  state = "connecting";
}

const ticket: RelayTicket = {
  accessToken: "tok",
  clientId: "browser-1",
  clientName: "Chrome · macOS",
};

function setup(
  overrides: {
    idleGraceMs?: number;
    failNextConnect?: boolean;
    hangConnect?: boolean;
  } = {},
) {
  const built: FakeClient[] = [];
  const sockets: FakeConnection[] = [];
  let fail = overrides.failNextConnect ?? false;
  const tickets = vi.fn(() => Promise.resolve(ticket));
  const pool = new RelayClientPool({
    idleGraceMs: overrides.idleGraceMs ?? 30_000,
    ensureTicket: tickets,
    connectionUrl: () => "ws://relay.test/v1/relay/client",
    createConnection: (opts) => {
      const connection = new FakeConnection(opts);
      sockets.push(connection);
      return connection as unknown as RelayConnection;
    },
    createClient: (opts) => {
      const client = new FakeClient(opts);
      if (fail) {
        fail = false;
        client.connectResult = Promise.reject(new Error("boom"));
      }
      if (overrides.hangConnect)
        client.connectResult = new Promise<void>(() => {});
      built.push(client);
      return client as unknown as RelayClient;
    },
  });
  return { pool, built, sockets, tickets };
}

const FP1 = machineTarget("fp-1");
const FP2 = machineTarget("fp-2");

describe("RelayClientPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("同一个目标的多个使用方共用一条通道", async () => {
    const { pool, built, tickets } = setup();
    const a = await pool.acquire(FP1);
    const b = await pool.acquire(FP1);
    expect(built).toHaveLength(1);
    expect(a.client).toBe(b.client);
    // 票只换一次：连接是账号级的，通道再多也只有一条 socket。
    expect(tickets).toHaveBeenCalledTimes(1);
  });

  it("并发 acquire 不会抢建出两条通道", async () => {
    const { pool, built } = setup();
    const [a, b] = await Promise.all([pool.acquire(FP1), pool.acquire(FP1)]);
    expect(built).toHaveLength(1);
    expect(a.client).toBe(b.client);
  });

  it("不同目标各自一条通道，但共用那一条 socket", async () => {
    const { pool, built, sockets } = setup();
    await pool.acquire(FP1);
    await pool.acquire(FP2);
    expect(built).toHaveLength(2);
    expect(sockets).toHaveLength(1);
  });

  it("通知扇出给此刻在场的每个监听者", async () => {
    const { pool, built } = setup();
    const first = vi.fn();
    const second = vi.fn();
    await pool.acquire(FP1, { onEvent: first });
    await pool.acquire(FP1, { onEvent: second });

    const frame = { conversationId: "c-1", seq: 1, event: {} } as never;
    // 第二个实参是这一帧发生的时刻：扇出原样转出去，不在这一层改写。
    built[0].opts.onEvent?.(frame, 1700000000111);
    expect(first).toHaveBeenCalledWith(frame, 1700000000111);
    expect(second).toHaveBeenCalledWith(frame, 1700000000111);
  });

  it("release 之后这个监听者不再收到通知，别人照收", async () => {
    const { pool, built } = setup();
    const leaving = vi.fn();
    const staying = vi.fn();
    const lease = await pool.acquire(FP1, { onEvent: leaving });
    await pool.acquire(FP1, { onEvent: staying });

    lease.release();
    built[0].opts.onEvent?.(
      {
        conversationId: "c-1",
        seq: 1,
        event: {},
      } as never,
      1700000000111,
    );
    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });

  it("连接状态扇出给每个监听者", async () => {
    const { pool, built } = setup();
    const first = vi.fn();
    const second = vi.fn();
    await pool.acquire(FP1, { onStateChange: first });
    await pool.acquire(FP1, { onStateChange: second });

    built[0].opts.onStateChange?.("reconnecting");
    expect(first).toHaveBeenCalledWith("reconnecting");
    expect(second).toHaveBeenCalledWith("reconnecting");
  });

  /**
   * 状态变化是**事件**：`RelayClient.setState` 遇到相同值直接早退，所以一条早就
   * 连上的通道此后再也不会说话。后来的使用方（切走再切回来的详情页）因此永远等
   * 不到那一句，屏幕上停在自己的初值「连接中…」。
   *
   * 交出租约时把当下的状态补给新监听者，这条路才闭合——`subscribeSignals` 那侧
   * 早就这么做了，普通通道漏了。
   */
  it("借到一条早就连上的通道时，当场把状态补给新监听者", async () => {
    const { pool, built } = setup();
    const first = await pool.acquire(FP1);
    built[0].state = "connected";
    built[0].opts.onStateChange?.("connected");

    const late = vi.fn();
    await pool.acquire(FP1, { onStateChange: late });

    expect(late).toHaveBeenCalledWith("connected");
    expect(first.client).toBe(built[0] as unknown as RelayClient);
  });

  it("最后一个使用方走后进入空闲宽限，宽限内再来的人复用同一条", async () => {
    const { pool, built } = setup({ idleGraceMs: 30_000 });
    const lease = await pool.acquire(FP1);
    lease.release();

    vi.advanceTimersByTime(29_000);
    const again = await pool.acquire(FP1);
    expect(built).toHaveLength(1);
    expect(again.client).toBe(lease.client);
    expect(built[0].closed).toBe(0);
  });

  it("空闲宽限走完才真正关掉那一条通道", async () => {
    const { pool, built, sockets } = setup({ idleGraceMs: 30_000 });
    const lease = await pool.acquire(FP1);
    lease.release();
    expect(built[0].closed).toBe(0);

    vi.advanceTimersByTime(30_000);
    expect(built[0].closed).toBe(1);
    // 关的是通道不是 socket：宽限只管普通通道的关闭时机（决策 13）。
    expect(sockets[0].closed).toBe(0);

    // 关掉之后再来的人拿到的是新的一条。
    await pool.acquire(FP1);
    expect(built).toHaveLength(2);
  });

  it("还有人在用时，某一个使用方 release 不会关掉通道", async () => {
    const { pool, built } = setup({ idleGraceMs: 1_000 });
    const lease = await pool.acquire(FP1);
    await pool.acquire(FP1);

    lease.release();
    vi.advanceTimersByTime(10_000);
    expect(built[0].closed).toBe(0);
  });

  it("release 是幂等的：同一份租约调两次不会扣掉别人的引用", async () => {
    const { pool, built } = setup({ idleGraceMs: 1_000 });
    const lease = await pool.acquire(FP1);
    await pool.acquire(FP1);

    lease.release();
    lease.release();
    vi.advanceTimersByTime(10_000);
    expect(built[0].closed).toBe(0);
  });

  it("连不上时把条目摘掉，下一次 acquire 真的重开而不是复读同一个失败", async () => {
    const { pool, built } = setup({ failNextConnect: true });
    await expect(pool.acquire(FP1)).rejects.toThrow("boom");
    // 失败那条不能留在池子里：留着的话这台机器在这一屏里永远打不开。
    await pool.acquire(FP1);
    expect(built).toHaveLength(2);
  });

  /*
    长连接的使用方(详情页)要的是**另一档**语义:它不等连上,拿到 client 就挂上去,
    首次连不上交给连接自己退避重连,页面从 onStateChange 读 "reconnecting"。
    等连上再交付会把这条路堵死 —— 首次失败当场变成 "disconnected"(「已经不再自动
    重试」),而实际上它正在重试。
  */
  it("waitForConnect:false 不等连上就交出租约", async () => {
    const { pool, built } = setup({ hangConnect: true });
    const lease = await pool.acquire(FP1, {}, { waitForConnect: false });
    expect(lease.client).toBe(built[0] as unknown as RelayClient);
    expect(built[0].connects).toBe(1);
  });

  it("waitForConnect:false 时首次连不上不摘条目：交给连接自己重连", async () => {
    const { pool, built } = setup({ failNextConnect: true });
    const lease = await pool.acquire(FP1, {}, { waitForConnect: false });
    expect(built).toHaveLength(1);
    expect(built[0].closed).toBe(0);
    // 条目还在：后来的人搭的是同一条，而不是又开一条。
    await pool.acquire(FP1, {}, { waitForConnect: false });
    expect(built).toHaveLength(1);
    lease.release();
  });

  /*
    重连换的是**那一条 socket**，不是每个目标各自重来：这个账号只有一条连接，
    通道与引用计数原样留着，手里的 RelayClient 也不换人——每条通道在新 socket 上
    重新声明目标、重做自己的握手（RelayConnection.reconnect）。
  */
  it("reconnect 换掉底下那条 socket，通道与租约原样留着", async () => {
    const { pool, built, sockets } = setup();
    const lease = await pool.acquire(FP1);
    await pool.acquire(FP2);

    await expect(pool.reconnect(FP1)).resolves.toBe(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].reconnects).toBe(1);
    expect(built).toHaveLength(2);
    expect(lease.client).toBe(built[0] as unknown as RelayClient);
    expect(built[0].closed).toBe(0);
  });

  /*
    池子里没有这条通道（票根本没换到、连接压根没建出来）时 reconnect 交回 false：
    use-relay 据此退回「整只 effect 从取票重跑」那条兜底路。分不出这一档的话，
    「重新连接」按钮在取票失败之后会变成一颗按了什么都不发生的按钮。
  */
  it("池子里没有这条通道时 reconnect 交回 false", async () => {
    const { pool, built } = setup();
    await expect(pool.reconnect(machineTarget("fp-nobody"))).resolves.toBe(
      false,
    );
    expect(built).toHaveLength(0);
  });

  it("closeAll 收掉全部通道与那条连接（登出）", async () => {
    const { pool, built, sockets } = setup();
    await pool.acquire(FP1);
    await pool.acquire(FP2);
    pool.closeAll();
    expect(built[0].closed).toBe(1);
    expect(built[1].closed).toBe(1);
    expect(sockets[0].closed).toBe(1);
    expect(pool.size).toBe(0);
    expect(pool.channelCount).toBe(0);
  });

  /*
    规格「按对话寻址 · 失败按通道隔离」：通道级失败（目标不存在 / 离线 / 转发失败）
    只判死那一条通道，「客户端据此只把那一条通道标为不可达」。

    被判死之后它必须还能被重新开出来——用户按「重新连接」走的正是 pool.reconnect。
    换 socket 只会把连接**通道表里还在**的那些重新声明一遍，被服务端关掉的这一条
    已经不在表里了，所以池子得显式让它重开。

    RED 之前：reconnect 只换 socket 就返回 true，use-relay 据此不再退回「整只
    effect 重跑」那条兜底路，于是那条对话在这个标签页里永久死亡。
  */
  it("重连把被服务端关掉的通道重新开出来", async () => {
    const { pool, built, sockets } = setup();
    await pool.acquire(FP1);
    await pool.acquire(FP2);
    expect(sockets).toHaveLength(1);

    expect(await pool.reconnect(FP1)).toBe(true);

    // 换的是那条共享 socket，不是某一条通道。
    expect(sockets[0].reconnects).toBe(1);
    // 而这条通道自己要被重开：reopen 对「通道还在」是空操作，所以调它是安全的，
    // 不调则被关掉的那一条再也回不来。
    expect(built[0].reopens).toBe(1);
    // 别人的通道不受牵连：换 socket 之后它们由连接自己重新声明。
    expect(built[1].reopens).toBe(0);
    expect(built[1].closed).toBe(0);
  });
});
