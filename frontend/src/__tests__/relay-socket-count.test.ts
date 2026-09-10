import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RelayClient, RelayClientOptions } from "@/lib/relayClient";
import type { RelayConnection } from "@/lib/relayConnection";
import { RelayClientPool } from "@/lib/relayClientPool";
import { conversationTarget, machineTarget } from "@/lib/relayTarget";
import type { RelayTicket } from "@/lib/relayTicket";

/**
 * 本轮的目标数字（决策 10 + 13）：**一个账号一条 WebSocket**。
 *
 * 断言的是池子里的 socket 数本身，不是「东西还能用」——按机器建池时这一屏照样
 * 能用，只是开了 N 条连接，而那正是要修的东西。
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
  constructor(readonly opts: RelayClientOptions) {}
  connect(): Promise<void> {
    return Promise.resolve();
  }
  reopen(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    this.closed++;
  }
}

const ticket: RelayTicket = {
  accessToken: "tok",
  expiresAt: Date.now() + 120_000,
  clientId: "browser-1",
  clientName: "Chrome · macOS",
};

/** 把微任务队列跑空：连接是在取票之后才建出来的。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function setup(idleGraceMs = 30_000) {
  const sockets: FakeConnection[] = [];
  const clients: FakeClient[] = [];
  const pool = new RelayClientPool({
    idleGraceMs,
    ensureTicket: () => Promise.resolve(ticket),
    connectionUrl: () => "ws://relay.test/v1/relay/client",
    createConnection: (opts) => {
      const connection = new FakeConnection(opts);
      sockets.push(connection);
      return connection as unknown as RelayConnection;
    },
    createClient: (opts) => {
      const client = new FakeClient(opts);
      clients.push(client);
      return client as unknown as RelayClient;
    },
  });
  return { pool, sockets, clients };
}

describe("一个账号一条 WebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("同时观察 N 台机器上的对话，浏览器持有的 socket 总数是 1", async () => {
    const { pool, sockets, clients } = setup();
    await pool.acquire(machineTarget("fp-1"));
    await pool.acquire(machineTarget("fp-2"));
    await pool.acquire(machineTarget("fp-3"));
    await pool.acquire(
      conversationTarget("11111111-1111-7111-8111-111111111111"),
    );

    expect(sockets).toHaveLength(1);
    expect(pool.size).toBe(1);
    // 四个目标 = 同一条连接上的四条虚拟通道（决策 10 的入口分流）。
    expect(pool.channelCount).toBe(4);
    expect(clients).toHaveLength(4);
  });

  it("零台机器在线时仍然是 1：信号通道是永不释放的使用方", async () => {
    const { pool, sockets } = setup(30_000);
    const stop = pool.subscribeSignals(() => {});
    await flush();
    expect(pool.size).toBe(1);

    // 借了又还的普通通道走完空闲宽限之后连接照旧在：宽限只管普通通道的关闭时机。
    const lease = await pool.acquire(machineTarget("fp-1"));
    lease.release();
    vi.advanceTimersByTime(60_000);
    expect(pool.channelCount).toBe(0);
    expect(pool.size).toBe(1);
    expect(sockets[0].closed).toBe(0);

    stop();
    // 只有登出（closeAll）才收掉这一条。
    expect(pool.size).toBe(1);
    pool.closeAll();
    expect(pool.size).toBe(0);
    expect(sockets[0].closed).toBe(1);
  });

  it("同一台机器的两个使用方共用一条通道，不同目标各占一条", async () => {
    const { pool, clients } = setup();
    const a = await pool.acquire(machineTarget("fp-1"));
    const b = await pool.acquire(machineTarget("fp-1"));
    expect(a.client).toBe(b.client);
    expect(clients).toHaveLength(1);

    await pool.acquire(machineTarget("fp-2"));
    expect(clients).toHaveLength(2);
    expect(pool.size).toBe(1);
  });

  it("重连换的是那一条 socket，不是每台机器各自重来", async () => {
    const { pool, sockets } = setup();
    await pool.acquire(machineTarget("fp-1"));
    await pool.acquire(machineTarget("fp-2"));

    await expect(pool.reconnect(machineTarget("fp-1"))).resolves.toBe(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].reconnects).toBe(1);
  });
});
