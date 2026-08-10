/**
 * 浏览器中继客户端测试(测试接缝 2)。
 *
 * 三条核心行为,Go 侧对照是 agentre 的 internal/daemon/client/client_test.go:
 *  1. 多路复用不串道:并发请求按 JSON-RPC id 隔离,乱序响应各归各的。
 *  2. 断线后按 seq 游标补齐,重复投递只应用一次(补齐与实时走同一套去重)。
 *  3. attach 幂等:重复调用不重复发请求。
 *
 * WebSocket 用假实现替身(jsdom 有 WebSocket 全局但不会真的连),由测试手动
 * 驱动 open / receive / close,把帧往返做成确定性。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RelayClient,
  type RelayClientOptions,
  type RelayState,
} from "@/lib/relayClient";
import { type WireFrame, encodeFrame } from "@/lib/wire";

// ── 假 WebSocket ────────────────────────────────────────────────────────────

const text = new TextDecoder();
const encode = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  url: string;
  headers: Record<string, string>;
  binaryType = "blob";
  readyState = 0;
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, headers?: Record<string, string>) {
    this.url = url;
    this.headers = headers ?? {};
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 未 open 就失败(连接建立失败)。 */
  fail(): void {
    this.onerror?.();
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  send(data: unknown): void {
    this.sent.push(data as ArrayBuffer);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function lastSent(ws: FakeWebSocket): WireFrame {
  const buf = ws.sent[ws.sent.length - 1];
  return JSON.parse(text.decode(buf)) as WireFrame;
}

function waitSent(ws: FakeWebSocket, n: number): Promise<void> {
  return vi.waitFor(() => {
    expect(ws.sent.length).toBe(n);
  });
}

/** 建立连接并驱动首条 WebSocket open,返回那条连接供测试驱动。 */
async function connectClient(client: RelayClient): Promise<FakeWebSocket> {
  const p = client.connect();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.open();
  await authenticate(ws);
  await p;
  // 把握手帧从 sent 里弹掉,后续测试按「首个请求」索引不受影响。
  ws.sent.shift();
  return ws;
}

/**
 * 驱动 auth.account 握手:open 后客户端先发 auth.account,daemon 回 {ok:true}
 * connect() 才 resolve。供初连与重连两处复用。
 */
async function authenticate(ws: FakeWebSocket): Promise<void> {
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
  const auth = lastSent(ws);
  expect(auth.method).toBe("auth.account");
  expect(auth.params).toMatchObject({
    credential: JWT,
    deviceFingerprint: "fp-web",
  });
  ws.receive(
    encode(encodeFrame({ jsonrpc: "2.0", id: auth.id, result: { ok: true } })),
  );
}

const URL = "ws://relay.test/v1/relay/client?daemon_fingerprint=fp-web";
const JWT = "device-jwt-abc";

function makeClient(overrides: Partial<RelayClientOptions> = {}): RelayClient {
  return new RelayClient({
    url: URL,
    jwt: JWT,
    deviceFingerprint: "fp-web",
    reconnect: false,
    createWebSocket: (u, h) => new FakeWebSocket(u, h) as unknown as WebSocket,
    ...overrides,
  });
}

afterEach(() => {
  FakeWebSocket.reset();
});

describe("中继客户端:多路复用不串道", () => {
  it("并发请求按 id 隔离,乱序响应各归各的", async () => {
    const client = makeClient();
    const ws = await connectClient(client);
    expect(ws.url).toBe(URL);
    expect(ws.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(ws.binaryType).toBe("arraybuffer");

    const pList = client.request("runtime.session.list");
    const pPull = client.request("runtime.session.pull", {
      sessionId: 1,
      cursor: 0,
      limit: 200,
    });
    await waitSent(ws, 2);

    const f1 = lastSent(ws);
    const f2 = JSON.parse(
      text.decode(ws.sent[ws.sent.length - 2]),
    ) as WireFrame;
    expect(f1.method).toBe("runtime.session.pull");
    expect(f2.method).toBe("runtime.session.list");
    expect(f1.id).not.toBe(f2.id);
    expect(f1.params).toEqual({ sessionId: 1, cursor: 0, limit: 200 });

    // 乱序:先答第 2 个请求,再答第 1 个 —— 各自拿到自己的结果。
    ws.receive(
      encode(encodeFrame({ jsonrpc: "2.0", id: f1.id, result: { cursor: 0 } })),
    );
    await expect(pPull).resolves.toEqual({ cursor: 0 });

    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: f2.id,
          result: {
            sessions: [{ sessionId: 1, lifecycleState: "idle", latestSeq: 0 }],
          },
        }),
      ),
    );
    await expect(pList).resolves.toMatchObject({
      sessions: [{ sessionId: 1 }],
    });
    client.close();
  });

  it("错误响应拒绝对应请求,且不影响其它未决请求", async () => {
    const client = makeClient();
    const ws = await connectClient(client);

    const pGood = client.request("runtime.session.list");
    const pBad = client.request("runtime.session.attach", { sessionId: 9 });
    await waitSent(ws, 2);
    const goodFrame = JSON.parse(text.decode(ws.sent[0])) as WireFrame;
    const badFrame = lastSent(ws);

    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: badFrame.id,
          error: { code: -32014, message: "session not found" },
        }),
      ),
    );
    await expect(pBad).rejects.toThrow("session not found");

    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: goodFrame.id,
          result: { sessions: [] },
        }),
      ),
    );
    await expect(pGood).resolves.toEqual({ sessions: [] });
    client.close();
  });
});

describe("中继客户端:断线后按 seq 游标补齐,重复投递只应用一次", () => {
  it("重连后 attach → 按已有游标 pull,补齐与实时同一条去重纪律", async () => {
    const events: Array<{ seq?: number; text: string }> = [];
    const client = makeClient({
      reconnect: true,
      reconnectDelayMs: 5,
      onEvent: (frame) => {
        const ev = frame.event as { kind: string; text: string };
        events.push({ seq: frame.seq, text: ev.text });
      },
    });
    let ws = await connectClient(client);

    // 先显式接管(attach),此后该会话进入关注名单,断线重连会自动补齐。
    const attachP = client.attach(42);
    await waitSent(ws, 1);
    const attachReq = lastSent(ws);
    expect(attachReq.method).toBe("runtime.session.attach");
    expect(attachReq.params).toEqual({ sessionId: 42 });
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: attachReq.id,
          result: {
            sessionId: 42,
            backendType: "claudecode",
            lifecycleState: "running",
            latestSeq: 5,
          },
        }),
      ),
    );
    await expect(attachP).resolves.toMatchObject({ latestSeq: 5 });

    // 在线时收 2 条实时通知(seq 1、2),游标推进到 2。
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          method: "runtime.event",
          params: {
            sessionId: 42,
            event: { kind: "text_delta", text: "a" },
            seq: 1,
          },
        }),
      ),
    );
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          method: "runtime.event",
          params: {
            sessionId: 42,
            event: { kind: "text_delta", text: "b" },
            seq: 2,
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(events).toHaveLength(2));

    // 断线(seq 3、4 在离线期间产生)。
    ws.serverClose();

    // 自动重连:第二条连接,同样先 auth.account,再 attach → pull(cursor 必须是 2,独占,不是 0)。
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    ws = FakeWebSocket.instances[1];
    ws.open();
    await authenticate(ws);
    ws.sent.shift(); // 握手帧弹掉,后续按「首个请求」计数
    await waitSent(ws, 1);
    const reattach = lastSent(ws);
    expect(reattach.method).toBe("runtime.session.attach");
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: reattach.id,
          result: {
            sessionId: 42,
            backendType: "claudecode",
            lifecycleState: "running",
            latestSeq: 4,
          },
        }),
      ),
    );
    await waitSent(ws, 2);
    const pullReq = lastSent(ws);
    expect(pullReq.method).toBe("runtime.session.pull");
    expect(pullReq.params).toEqual({ sessionId: 42, cursor: 2, limit: 200 });

    // 补齐页:seq 3、4 是真缺的;seq 2 是重复(≤ 游标),只应用一次。
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: pullReq.id,
          result: {
            notifications: [
              {
                seq: 3,
                method: "runtime.event",
                params: {
                  sessionId: 42,
                  event: { kind: "text_delta", text: "c" },
                },
              },
              {
                seq: 4,
                method: "runtime.event",
                params: {
                  sessionId: 42,
                  event: { kind: "text_delta", text: "d" },
                },
              },
              {
                seq: 2,
                method: "runtime.event",
                params: {
                  sessionId: 42,
                  event: { kind: "text_delta", text: "a" },
                },
              },
            ],
            cursor: 4,
            hasMore: false,
            oldestSeq: 1,
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events.map((e) => e.text)).toEqual(["a", "b", "c", "d"]);

    // 实时再推一条与已应用相同的 seq 3 → 丢弃;seq 5 → 应用。
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          method: "runtime.event",
          params: {
            sessionId: 42,
            event: { kind: "text_delta", text: "c" },
            seq: 3,
          },
        }),
      ),
    );
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          method: "runtime.event",
          params: {
            sessionId: 42,
            event: { kind: "text_delta", text: "e" },
            seq: 5,
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(events).toHaveLength(5));
    expect(events.map((e) => e.text)).toEqual(["a", "b", "c", "d", "e"]);
    client.close();
  });

  it("游标落进已被回收的老前缀时,按 OldestSeq 复位再补齐", async () => {
    const events: Array<{ seq?: number; text: string }> = [];
    const client = makeClient({
      reconnect: false,
      onEvent: (frame) => {
        const ev = frame.event as { text: string };
        events.push({ seq: frame.seq, text: ev.text });
      },
    });
    const ws = await connectClient(client);

    const attachP = client.attach(42);
    await waitSent(ws, 1);
    const attachReq = lastSent(ws);
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: attachReq.id,
          result: { sessionId: 42, lifecycleState: "running", latestSeq: 9 },
        }),
      ),
    );
    await expect(attachP).resolves.toBeTruthy();

    // 模拟客户端本地游标已落后于留存窗口(老前缀被回收)。
    client.setCursor(42, 0);
    const catchUpP = client.catchUp(42);
    await waitSent(ws, 2);
    const pullReq = lastSent(ws);
    // 先按 0 拉,得到 oldestSeq=5 后复位到 4 再拉 —— 这里是第一拉,发的是 0。
    expect(pullReq.method).toBe("runtime.session.pull");
    expect(pullReq.params).toEqual({ sessionId: 42, cursor: 0, limit: 200 });

    // 第一拉:oldestSeq 5 > cursor+1,客户端应复位到 4 再拉,而不是把 0 当游标。
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: pullReq.id,
          result: {
            notifications: [],
            cursor: 0,
            hasMore: true,
            oldestSeq: 5,
          },
        }),
      ),
    );
    await waitSent(ws, 3);
    const secondPull = lastSent(ws);
    expect(secondPull.params).toEqual({ sessionId: 42, cursor: 4, limit: 200 });
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: secondPull.id,
          result: {
            notifications: [
              {
                seq: 5,
                method: "runtime.event",
                params: {
                  sessionId: 42,
                  event: { kind: "text_delta", text: "tail" },
                },
              },
            ],
            cursor: 5,
            hasMore: false,
            oldestSeq: 5,
          },
        }),
      ),
    );
    await catchUpP;
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ seq: 5, text: "tail" });
    client.close();
  });
});

describe("中继客户端:握手完成前不对外暴露 connected", () => {
  it("auth.account 返回前 state 不得是 connected(防 session.list 抢跑被 daemon 拒)", async () => {
    const states: RelayState[] = [];
    const client = makeClient({
      reconnect: false,
      onStateChange: (s) => states.push(s),
    });
    const p = client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open(); // WS 已建立,但 auth.account 握手还没回

    // 关键断言:握手返回前不能对外暴露 connected —— 页面靠它触发 session.list,
    // 抢跑会在 daemon 处理 auth.account 之前到达,被 Unauthorized 拒掉(实测竞态)。
    expect(client.state).not.toBe("connected");
    expect(states).not.toContain("connected");

    await authenticate(ws); // 握手返回 {ok:true}
    await p;
    expect(client.state).toBe("connected");
    expect(states).toContain("connected");
    client.close();
  });

  it("auth.account 失败时关掉未认证连接并进入 reconnecting(供 R11 探测)", async () => {
    const states: RelayState[] = [];
    const client = makeClient({
      reconnect: true,
      reconnectDelayMs: 5,
      onStateChange: (s) => states.push(s),
    });
    const p = client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const auth = lastSent(ws);
    expect(auth.method).toBe("auth.account");
    // daemon 拒绝握手(被吊销 / 账号不匹配 / 凭据过期)。
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: auth.id,
          error: { code: -32001, message: "account credential revoked" },
        }),
      ),
    );
    // daemon 的错误帧原样透传为 RelayError(消息即 daemon 的文案)。
    await expect(p).rejects.toThrow("account credential revoked");
    // 未认证的连接被关掉 → handleClose → reconnecting → 自动重连(R11 探测的入口)。
    await vi.waitFor(() => expect(states).toContain("reconnecting"));
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    client.close();
  });
});

describe("中继客户端:连接失败可重试", () => {
  it("首次连接失败后重试能连上(不残留已拒绝的 connectPromise)", async () => {
    const client = makeClient();
    const p1 = client.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.fail(); // 尚未 open 就出错 → 拒绝
    await expect(p1).rejects.toThrow("连接失败");

    // 再次 connect 必须新建一条连接(而不是拿到同一个已拒绝的 promise)。
    const p2 = client.connect();
    expect(FakeWebSocket.instances.length).toBe(2);
    FakeWebSocket.instances[1].open();
    await authenticate(FakeWebSocket.instances[1]);
    await p2;
    client.close();
  });
});

describe("中继客户端:attach 幂等", () => {
  it("并发重复 attach 只发一个请求,成功后缓存不再发", async () => {
    const client = makeClient();
    const ws = await connectClient(client);

    const p1 = client.attach(42);
    const p2 = client.attach(42); // 第一个还没回来,必须复用同一个 in-flight 请求
    await waitSent(ws, 1);
    const req = lastSent(ws);
    expect(req.method).toBe("runtime.session.attach");
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: req.id,
          result: { sessionId: 42, lifecycleState: "running", latestSeq: 5 },
        }),
      ),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.latestSeq).toBe(5);
    expect(r2.latestSeq).toBe(5);

    // 成功后重复调用:走缓存,不再发请求。
    await expect(client.attach(42)).resolves.toMatchObject({ latestSeq: 5 });
    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    client.close();
  });

  // R4/R6/R9:别的对端发起的会话在 daemon 上的键是 (发起端指纹, 会话 id)。清单在
  // SessionSummary.peerFingerprint 交出这个 origin,客户端学到之后必须原样带回此后
  // 每一次 attach / pull —— 省略即「调用方自己的对端」,接的会是本浏览器名下那条同号
  // 空会话。origin 记在客户端里,断线重连的自动补齐不必再由页面喂一次。
  it("学到的 origin 指纹带进 attach 与 pull,并在重连补齐时沿用", async () => {
    const client = makeClient({ reconnect: true, reconnectDelayMs: 0 });
    const ws = await connectClient(client);

    const p = client.catchUp(42, "fp-desktop");
    await waitSent(ws, 1);
    const attach = lastSent(ws);
    expect(attach.method).toBe("runtime.session.attach");
    expect(attach.params).toMatchObject({
      sessionId: 42,
      peerFingerprint: "fp-desktop",
    });
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: attach.id,
          result: { sessionId: 42, lifecycleState: "idle", latestSeq: 0 },
        }),
      ),
    );
    await waitSent(ws, 2);
    const pull = lastSent(ws);
    expect(pull.method).toBe("runtime.session.pull");
    expect(pull.params).toMatchObject({
      sessionId: 42,
      peerFingerprint: "fp-desktop",
    });
    ws.receive(
      encode(
        encodeFrame({
          jsonrpc: "2.0",
          id: pull.id,
          result: { cursor: 0, notifications: [], hasMore: false },
        }),
      ),
    );
    await p;

    // 断线重连:自动补齐必须仍然点名同一个 origin(页面不会再喂一次)。
    ws.serverClose();
    await vi.waitFor(() =>
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1),
    );
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws2.open();
    await authenticate(ws2);
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThan(1));
    const reattach = ws2.sent
      .map((raw) => JSON.parse(text.decode(raw)) as WireFrame)
      .find((f) => f.method === "runtime.session.attach");
    expect(reattach?.params).toMatchObject({
      sessionId: 42,
      peerFingerprint: "fp-desktop",
    });
    client.close();
  });
});
