import { beforeEach, describe, expect, it, vi } from "vitest";

import { RelayClientPool } from "@/lib/relayClientPool";
import type { RelayClient, RelayClientOptions } from "@/lib/relayClient";
import type { RelayTicket } from "@/lib/relayTicket";

/**
 * 池子的行为规格。这里**不**碰真的 WebSocket：池子的职责是「同一台机器只开一条
 * 连接、谁都不许替别人关掉它」，与帧怎么编解码无关（那是 relay-client-protobuf
 * 那一份用例的事）。所以 RelayClient 整个被替成一个能数出「建了几条、关了几条」
 * 的替身。
 */
class FakeClient {
  closed = 0;
  connects = 0;
  connectResult: Promise<void> = Promise.resolve();
  constructor(readonly opts: RelayClientOptions) {}
  connect(): Promise<void> {
    this.connects++;
    return this.connectResult;
  }
  close(): void {
    this.closed++;
  }
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
  let fail = overrides.failNextConnect ?? false;
  const tickets = vi.fn(() => Promise.resolve(ticket));
  const pool = new RelayClientPool({
    idleGraceMs: overrides.idleGraceMs ?? 30_000,
    ensureTicket: tickets,
    clientUrl: (fingerprint) => `ws://relay.test/${fingerprint}`,
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
  return { pool, built, tickets };
}

describe("RelayClientPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("同一台机器的多个使用方共用一条连接", async () => {
    const { pool, built, tickets } = setup();
    const a = await pool.acquire("fp-1");
    const b = await pool.acquire("fp-1");
    expect(built).toHaveLength(1);
    expect(a.client).toBe(b.client);
    // 票也只换一次：每个使用方各换一张是当前一次性调用最贵的那一步。
    expect(tickets).toHaveBeenCalledTimes(1);
  });

  it("并发 acquire 不会抢建出两条连接", async () => {
    const { pool, built } = setup();
    const [a, b] = await Promise.all([
      pool.acquire("fp-1"),
      pool.acquire("fp-1"),
    ]);
    expect(built).toHaveLength(1);
    expect(a.client).toBe(b.client);
  });

  it("不同机器各自一条连接", async () => {
    const { pool, built } = setup();
    await pool.acquire("fp-1");
    await pool.acquire("fp-2");
    expect(built).toHaveLength(2);
  });

  it("通知扇出给此刻在场的每个监听者", async () => {
    const { pool, built } = setup();
    const first = vi.fn();
    const second = vi.fn();
    await pool.acquire("fp-1", { onEvent: first });
    await pool.acquire("fp-1", { onEvent: second });

    const frame = { sessionId: 1, seq: 1, event: {} } as never;
    built[0].opts.onEvent?.(frame);
    expect(first).toHaveBeenCalledWith(frame);
    expect(second).toHaveBeenCalledWith(frame);
  });

  it("release 之后这个监听者不再收到通知，别人照收", async () => {
    const { pool, built } = setup();
    const leaving = vi.fn();
    const staying = vi.fn();
    const lease = await pool.acquire("fp-1", { onEvent: leaving });
    await pool.acquire("fp-1", { onEvent: staying });

    lease.release();
    built[0].opts.onEvent?.({ sessionId: 1, seq: 1, event: {} } as never);
    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });

  it("连接状态扇出给每个监听者", async () => {
    const { pool, built } = setup();
    const first = vi.fn();
    const second = vi.fn();
    await pool.acquire("fp-1", { onStateChange: first });
    await pool.acquire("fp-1", { onStateChange: second });

    built[0].opts.onStateChange?.("reconnecting");
    expect(first).toHaveBeenCalledWith("reconnecting");
    expect(second).toHaveBeenCalledWith("reconnecting");
  });

  it("最后一个使用方走后进入空闲宽限，宽限内再来的人复用同一条", async () => {
    const { pool, built } = setup({ idleGraceMs: 30_000 });
    const lease = await pool.acquire("fp-1");
    lease.release();

    vi.advanceTimersByTime(29_000);
    const again = await pool.acquire("fp-1");
    expect(built).toHaveLength(1);
    expect(again.client).toBe(lease.client);
    expect(built[0].closed).toBe(0);
  });

  it("空闲宽限走完才真正关掉", async () => {
    const { pool, built } = setup({ idleGraceMs: 30_000 });
    const lease = await pool.acquire("fp-1");
    lease.release();
    expect(built[0].closed).toBe(0);

    vi.advanceTimersByTime(30_000);
    expect(built[0].closed).toBe(1);

    // 关掉之后再来的人拿到的是新的一条。
    await pool.acquire("fp-1");
    expect(built).toHaveLength(2);
  });

  it("还有人在用时，某一个使用方 release 不会关掉连接", async () => {
    const { pool, built } = setup({ idleGraceMs: 1_000 });
    const lease = await pool.acquire("fp-1");
    await pool.acquire("fp-1");

    lease.release();
    vi.advanceTimersByTime(10_000);
    expect(built[0].closed).toBe(0);
  });

  it("release 是幂等的：同一份租约调两次不会扣掉别人的引用", async () => {
    const { pool, built } = setup({ idleGraceMs: 1_000 });
    const lease = await pool.acquire("fp-1");
    await pool.acquire("fp-1");

    lease.release();
    lease.release();
    vi.advanceTimersByTime(10_000);
    expect(built[0].closed).toBe(0);
  });

  it("连不上时把条目摘掉，下一次 acquire 真的重拨而不是复读同一个失败", async () => {
    const { pool, built } = setup({ failNextConnect: true });
    await expect(pool.acquire("fp-1")).rejects.toThrow("boom");
    // 失败那条不能留在池子里：留着的话这台机器在这一屏里永远打不开。
    await pool.acquire("fp-1");
    expect(built).toHaveLength(2);
  });

  /*
    长连接的使用方(详情页)要的是**另一档**语义:它不等连上,拿到 client 就挂上去,
    首次连不上交给 RelayClient 自己退避重连,页面从 onStateChange 读 "reconnecting"。
    等连上再交付会把这条路堵死 —— 首次失败当场变成 "disconnected"(「已经不再自动
    重试」),而实际上它正在重试。
  */
  it("waitForConnect:false 不等连上就交出租约", async () => {
    const { pool, built } = setup({ hangConnect: true });
    // 连接永远不落定，租约照样到手 —— 默认那一档在这里会一直挂着。
    const lease = await pool.acquire("fp-1", {}, { waitForConnect: false });
    expect(lease.client).toBe(built[0] as unknown as RelayClient);
    expect(built[0].connects).toBe(1);
  });

  it("waitForConnect:false 时首次连不上不摘条目：交给 RelayClient 自己重连", async () => {
    const { pool, built } = setup({ failNextConnect: true });
    const lease = await pool.acquire("fp-1", {}, { waitForConnect: false });
    expect(built).toHaveLength(1);
    expect(built[0].closed).toBe(0);
    // 条目还在：后来的人搭的是同一条，而不是又建一条。
    await pool.acquire("fp-1", {}, { waitForConnect: false });
    expect(built).toHaveLength(1);
    lease.release();
  });

  it("reconnect 关掉旧的、建新的，并把新 client 交给还在场的监听者", async () => {
    const { pool, built } = setup();
    const onClient = vi.fn();
    const lease = await pool.acquire("fp-1", { onClient });
    expect(built).toHaveLength(1);

    await expect(pool.reconnect("fp-1")).resolves.toBe(true);
    expect(built).toHaveLength(2);
    expect(built[0].closed).toBe(1);
    expect(onClient).toHaveBeenCalledWith(built[1]);
    // 租约仍然有效，且指向新的那一条。
    expect(lease.client).toBe(built[1] as unknown as RelayClient);
  });

  /*
    池子里没有这台机器（票根本没换到、连接压根没建出来）时 reconnect 交回 false：
    use-relay 据此退回「整只 effect 从取票重跑」那条兜底路。分不出这一档的话，
    「重新连接」按钮在取票失败之后会变成一颗按了什么都不发生的按钮。
  */
  /*
    重建期间旧那条会被 close，而 close 会让 RelayClient 播一次 "disconnected"。
    那一声不能落到监听者身上：详情页刚把状态设成 "connecting"（用户按了重新连接），
    紧接着被这一声改写成 "disconnected" —— 界面当场退回红色终态「已经不再自动重试」，
    说的和按钮正在做的事恰好相反。被顶替的那条连接说什么都不再作数。
  */
  it("重建时旧连接的 close 不再被当作状态变化播出去", async () => {
    const { pool, built } = setup();
    const onStateChange = vi.fn();
    await pool.acquire("fp-1", { onStateChange });

    const old = built[0];
    await pool.reconnect("fp-1");
    onStateChange.mockClear();
    old.opts.onStateChange?.("disconnected");
    expect(onStateChange).not.toHaveBeenCalled();

    // 现役那条照常播。
    built[1].opts.onStateChange?.("connected");
    expect(onStateChange).toHaveBeenCalledWith("connected");
  });

  it("被顶替的连接也不再投递通知", async () => {
    const { pool, built } = setup();
    const onEvent = vi.fn();
    await pool.acquire("fp-1", { onEvent });
    const old = built[0];
    await pool.reconnect("fp-1");

    old.opts.onEvent?.({ sessionId: 1, seq: 1, event: {} } as never);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("池子里没有这台机器时 reconnect 交回 false", async () => {
    const { pool, built } = setup();
    await expect(pool.reconnect("fp-nobody")).resolves.toBe(false);
    expect(built).toHaveLength(0);
  });

  it("closeAll 收掉全部连接（登出）", async () => {
    const { pool, built } = setup();
    await pool.acquire("fp-1");
    await pool.acquire("fp-2");
    pool.closeAll();
    expect(built[0].closed).toBe(1);
    expect(built[1].closed).toBe(1);
    expect(pool.size).toBe(0);
  });
});
