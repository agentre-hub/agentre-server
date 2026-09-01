import {
  PROTOCOL_VERSION,
  ProtobufRpcCodec,
  encodeRpcCancel,
  rpcMethods,
  type JournaledNotification,
} from "@agentre-hub/agentre-wire";
import { describe, expect, it, vi } from "vitest";

import {
  applyJournalFrames,
  RelayClient,
  type RelayClientOptions,
} from "@/lib/relayClient";
import { RelayConnection } from "@/lib/relayConnection";
import { unwrapEnvelope, wrapEnvelope } from "@/lib/relayEnvelope";
import { machineTarget } from "@/lib/relayTarget";

/** 这一族用例里那条对话的身份。 */
const CID = "11111111-1111-7111-8111-111111111111";

/**
 * 一条假 socket。
 *
 * 它现在收发的是**信封**（决策 10：一条连接多条通道），而这一族用例问的是通道
 * 里面那一层 RPC，所以信封在这里拆开：`sent` 只收载荷，通道开通那一帧（目标声明）
 * 不计——它是连接那一层的事，`relay-socket-count` 与服务端的通道用例各自守着它。
 */
class BinarySocket {
  readyState = 0;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  /** 客户端给这条通道自选的号；回程按它套信封。 */
  channelId = "";
  /** 通道开通时声明的目标。 */
  target = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: unknown): void {
    const { channelId, frame } = unwrapEnvelope(data as Uint8Array);
    if (this.channelId === "") {
      this.channelId = channelId;
      this.target = new TextDecoder().decode(frame);
      return;
    }
    this.sent.push(frame);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: Uint8Array): void {
    this.onmessage?.({ data: wrapEnvelope(this.channelId, data) });
  }
}

function setup(overrides: Partial<RelayClientOptions> = {}): {
  client: RelayClient;
  socket: BinarySocket;
  protocols: string[];
} {
  const socket = new BinarySocket();
  const protocols: string[] = [];
  const connection = new RelayConnection({
    url: "ws://relay.test/v1/relay/client",
    jwt: "jwt",
    reconnect: false,
    createWebSocket: (_url, _headers, offered) => {
      protocols.push(...offered);
      return socket as unknown as WebSocket;
    },
  });
  const options: RelayClientOptions = {
    connection,
    target: machineTarget("fp-daemon"),
    jwt: "jwt",
    ...overrides,
  };
  return { client: new RelayClient(options), socket, protocols };
}

async function authenticate(
  client: RelayClient,
  socket: BinarySocket,
): Promise<void> {
  const connected = client.connect();
  socket.open();
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  const request = ProtobufRpcCodec.decode(socket.sent[0]);
  expect(request.body.case).toBe("typedMethodRequest");
  socket.receive(
    ProtobufRpcCodec.encodeTypedMethodResponse(
      request.id,
      rpcMethods.authAccount,
      { ok: true },
    ),
  );
  await connected;
  socket.sent = [];
}

describe("RelayClient Protobuf RPC boundary", () => {
  // Given 对端（agentred / 桌面端）在 auth.account 上按精确匹配校验协议版本，且把
  // 空版本一律判成「对端太旧」——proto3 里缺字段与显式空串同为零值；When 浏览器
  // 建连；Then 握手必须自报本次编译进来的 wire 包版本。
  //
  // 这一条单独守：漏掉它，浏览器端整个连不上（auth.account 成功才置 connected），
  // 而其余用例都用假 socket 回一个 {ok:true}，永远发现不了握手里少了个字段。
  it("advertises the wire package's protocol version in the auth.account handshake", async () => {
    const { client, socket } = setup();
    void client.connect();
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const frame = ProtobufRpcCodec.decode(socket.sent[0]);
    expect(frame.body.case).toBe("typedMethodRequest");
    const body = frame.body as {
      case: "typedMethodRequest";
      method: string;
      value: { protocolVersion?: string };
    };
    expect(body.method).toBe(rpcMethods.authAccount.name);
    // 与常量比而不是与 "0.1.0" 比：版本的主人是 wire 包的 package.json，字面量会
    // 在下一次协议升级时把这条测试变成一个必须手改的复制品。
    expect(body.value.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(PROTOCOL_VERSION).not.toBe("");
  });

  it("negotiates the binary subprotocol and multiplexes typed descriptors", async () => {
    const { client, socket, protocols } = setup();
    await authenticate(client, socket);
    // 第二个是携票的伪子协议：浏览器设不了 Authorization 头，而票走 URL 会落进
    // access log / history / Referer（见 relayUrl.ts）。
    expect(protocols).toEqual(["agentre-protobuf", "agentre.bearer.jwt"]);

    // 通道开通那一帧声明的就是这台机器（决策 10/11）。
    expect(socket.target).toBe("machine:fp-daemon");

    const list = client.request(rpcMethods.sessionList, {});
    const pull = client.request(rpcMethods.sessionPull, {
      conversationId: CID,
      cursor: 0n,
      limit: 200,
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const first = ProtobufRpcCodec.decode(socket.sent[0]);
    const second = ProtobufRpcCodec.decode(socket.sent[1]);
    expect(first.id).not.toBe(second.id);
    expect(first.body.case).toBe("typedMethodRequest");
    expect(second.body.case).toBe("typedMethodRequest");

    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        second.id,
        rpcMethods.sessionPull,
        { cursor: 0n },
      ),
    );
    await expect(pull).resolves.toMatchObject({ cursor: 0n });
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        first.id,
        rpcMethods.sessionList,
        {
          sessions: [],
        },
      ),
    );
    await expect(list).resolves.toMatchObject({ sessions: [] });
  });

  it("AbortSignal rejects locally and emits a typed cancel frame", async () => {
    const { client, socket } = setup();
    await authenticate(client, socket);
    const controller = new AbortController();
    const pending = client.request(
      rpcMethods.sessionList,
      {},
      {
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const request = ProtobufRpcCodec.decode(socket.sent[0]);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.sent[1]).toEqual(
      encodeRpcCancel(request.id + 1n, request.id),
    );
  });

  it("routes typed errors by request ID without disturbing another request", async () => {
    const { client, socket } = setup();
    await authenticate(client, socket);
    const failed = client.request(rpcMethods.sessionAttach, {
      conversationId: CID,
    });
    const healthy = client.request(rpcMethods.sessionList, {});
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const failedFrame = ProtobufRpcCodec.decode(socket.sent[0]);
    const healthyFrame = ProtobufRpcCodec.decode(socket.sent[1]);
    expect(failedFrame.id).toBe(2n);
    // RpcFrame{id:2,error:{code:123,message:"boom"}} 的 canonical Protobuf bytes。
    socket.receive(
      new Uint8Array([
        0x08, 0x02, 0x2a, 0x08, 0x08, 0x7b, 0x12, 0x04, 0x62, 0x6f, 0x6f, 0x6d,
      ]),
    );
    await expect(failed).rejects.toMatchObject({
      code: 123,
      message: "boom",
    });
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        healthyFrame.id,
        rpcMethods.sessionList,
        { sessions: [] },
      ),
    );
    await expect(healthy).resolves.toMatchObject({ sessions: [] });
  });

  it("rejects all pending requests on disconnect", async () => {
    const { client, socket } = setup();
    await authenticate(client, socket);
    const first = client.request(rpcMethods.sessionList, {});
    const second = client.request(rpcMethods.healthPing, {});
    socket.close();
    await expect(first).rejects.toThrow("连接已断开");
    await expect(second).rejects.toThrow("连接已断开");
  });

  it("drops a malformed binary frame and accepts the following valid response", async () => {
    const { client, socket } = setup();
    await authenticate(client, socket);
    const pending = client.request(rpcMethods.sessionList, {});
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const request = ProtobufRpcCodec.decode(socket.sent[0]);
    socket.receive(new Uint8Array([0xff, 0xff, 0xff]));
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        request.id,
        rpcMethods.sessionList,
        { sessions: [] },
      ),
    );
    await expect(pending).resolves.toMatchObject({ sessions: [] });
  });

  it("delivers typed Protobuf notifications without exposing wire bytes", async () => {
    const events: unknown[] = [];
    const { client, socket } = setup({
      onEvent: (event) => events.push(event),
    });
    await authenticate(client, socket);
    socket.receive(
      ProtobufRpcCodec.encode({
        id: 0n,
        body: {
          case: "runtimeEventNotification",
          conversationId: CID,
          seq: 1,
          event: { case: "textDelta", text: "hello" },
        },
      }),
    );
    await vi.waitFor(() =>
      expect(events).toEqual([
        {
          conversationId: CID,
          seq: 1,
          event: { kind: "text_delta", text: "hello" },
        },
      ]),
    );
  });
  // Given 日志里除了 runtime.event 还有轮次结束帧（`RpcNotification.run_result_done`，
  // 每跑完一轮就落一条）；When 打开一条已经跑完的对话、按游标补齐这一页；Then 整页
  // 必须照常交付 —— 事件进转录、结束帧进 onRunResultDone。
  //
  // 这一条守的是「补齐不因一种通知形态而整页失败」：补齐是 `notifications.map(...)`
  // 一次性投影的，任何一行抛出都会让整页连同 `catchUp()` 一起拒绝，详情页于是停在
  // 「没能从这台机器读到这条对话的内容」——而机器在线、内容也确实在那里。
  it("catches up a page that carries a run-result-done frame", async () => {
    const events: unknown[] = [];
    const done: unknown[] = [];
    const { client, socket } = setup({
      onEvent: (event) => events.push(event),
      onRunResultDone: (frame) => done.push(frame),
    });
    await authenticate(client, socket);

    const caughtUp = client.catchUp(CID, "fp-origin");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const attach = ProtobufRpcCodec.decode(socket.sent[0]);
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        attach.id,
        rpcMethods.sessionAttach,
        {
          conversationId: CID,
          backendType: "codex",
          lifecycleState: "idle",
          latestSeq: 2n,
        },
      ),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const pull = ProtobufRpcCodec.decode(socket.sent[1]);
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        pull.id,
        rpcMethods.sessionPull,
        {
          notifications: [
            {
              seq: 1n,
              payload: {
                payload: {
                  case: "runtimeEvent",
                  value: {
                    conversationId: CID,
                    event: { case: "textDelta", value: { text: "hi" } },
                  },
                },
              },
            },
            {
              seq: 2n,
              payload: {
                payload: {
                  case: "runResultDone",
                  value: {
                    conversationId: CID,
                    providerSessionId: "p-1",
                    turnToken: 1n,
                  },
                },
              },
            },
          ],
          cursor: 2n,
          hasMore: false,
          oldestSeq: 1n,
        },
      ),
    );

    await expect(caughtUp).resolves.toBeUndefined();
    // toMatchObject 而不是 toEqual：protobuf-es 解出来的事件带一个 $typeName
    // 运行时标记，它不是投影的一部分，断言它等于把 wire 运行时的实现细节钉进本仓。
    expect(events).toMatchObject([
      {
        conversationId: CID,
        seq: 1,
        event: { kind: "text_delta", text: "hi" },
      },
    ]);
    expect(done).toMatchObject([
      { conversationId: CID, seq: 2, providerSessionId: "p-1", turnToken: 1 },
    ]);
  });
  // Given server 镜像交出的一页历史里同样有轮次结束帧(GET /v1/agent-sessions/transcript
  // 的 `runtime.runResultDone`,由 Go 侧 internal/pkg/wireview 投影);When 详情页回放
  // 这一页;Then 它要投到 onRunResultDone —— loadMirrorTail 正是靠这一口在转录里补一条
  // 轮次结束的标记,解不出来就等于历史里每一轮都没有结束过。
  it("replays a mirror page whose frames include a run-result-done marker", () => {
    const events: unknown[] = [];
    const done: unknown[] = [];
    const last = applyJournalFrames(
      [
        {
          seq: 12,
          method: "runtime.event",
          params: {
            conversationId: CID,
            seq: 12,
            event: { kind: "text_delta", text: "hi" },
          },
        },
        {
          seq: 13,
          method: "runtime.runResultDone",
          params: {
            conversationId: CID,
            seq: 13,
            providerSessionId: "01a05211",
            model: "gpt-5.6-sol",
            contextWindow: 258400,
            turnToken: 1,
            usage: { promptTokens: 13694, completionTokens: 41 },
          },
        },
      ] as unknown as JournaledNotification[],
      {
        onEvent: (frame) => events.push(frame),
        onRunResultDone: (frame) => done.push(frame),
      },
    );

    expect(last).toBe(13);
    expect(events).toMatchObject([
      { conversationId: CID, event: { kind: "text_delta", text: "hi" } },
    ]);
    expect(done).toMatchObject([
      {
        conversationId: CID,
        seq: 13,
        providerSessionId: "01a05211",
        model: "gpt-5.6-sol",
        contextWindow: 258400,
        turnToken: 1,
        usage: { promptTokens: 13694, completionTokens: 41 },
      },
    ]);
  });
  // Given 日志里可以出现 RpcNotification 的**任意**一种形态（普通轮次的事件与结束、
  // 自主续轮的起/事件/止）；When 补齐把这一页翻成中间形状再投递；Then 五种都要
  // 落到各自那一口。
  //
  // 这一条是「按形态穷举」的守卫，不是又一条用例：上面那条 run-result-done 的红
  // 之所以能长期存在，正是因为补齐路径此前只被 textDelta 一种形态测过。少了这条，
  // 另外三种自主续轮的形态仍然是同一个坑，只是还没有人踩到。
  it("catches up every RpcNotification shape the journal can hold", async () => {
    const events: unknown[] = [];
    const done: unknown[] = [];
    const started: unknown[] = [];
    const { client, socket } = setup({
      onEvent: (frame) => events.push(frame),
      onRunResultDone: (frame) => done.push(frame),
      onAutonomousTurnStarted: (frame) => started.push(frame),
    });
    await authenticate(client, socket);

    const runtimeEvent = {
      conversationId: CID,
      event: { case: "textDelta" as const, value: { text: "hi" } },
    };
    const doneValue = {
      conversationId: CID,
      providerSessionId: "p-1",
      turnToken: 1n,
    };
    const shapes = [
      { case: "runtimeEvent", value: runtimeEvent },
      { case: "runResultDone", value: doneValue },
      {
        case: "autonomousTurnStarted",
        value: { conversationId: CID, trigger: "idle", turnToken: 2n },
      },
      { case: "autonomousTurnEvent", value: runtimeEvent },
      { case: "autonomousTurnDone", value: doneValue },
    ] as const;

    const caughtUp = client.catchUp(CID, "fp-origin");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const attach = ProtobufRpcCodec.decode(socket.sent[0]);
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        attach.id,
        rpcMethods.sessionAttach,
        {
          conversationId: CID,
          backendType: "codex",
          lifecycleState: "idle",
          latestSeq: BigInt(shapes.length),
        },
      ),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const pull = ProtobufRpcCodec.decode(socket.sent[1]);
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        pull.id,
        rpcMethods.sessionPull,
        {
          notifications: shapes.map((payload, i) => ({
            seq: BigInt(i + 1),
            payload: { payload },
          })),
          cursor: BigInt(shapes.length),
          hasMore: false,
          oldestSeq: 1n,
        },
      ),
    );

    await expect(caughtUp).resolves.toBeUndefined();
    // 自主续轮的事件与结束共用普通那两口（见 decodeNotification），所以是 2 / 2 / 1。
    expect(events.map((f) => (f as { seq: number }).seq)).toEqual([1, 4]);
    expect(done.map((f) => (f as { seq: number }).seq)).toEqual([2, 5]);
    expect(started.map((f) => (f as { seq: number }).seq)).toEqual([3]);
  });
});

/**
 * 补齐这条路上的终态帧要把本轮统计带全。
 *
 * `journaledFromProtobuf` 是这三份终态帧投影里的第三份（另两份是实时的
 * `decodeNotification` 与 server 镜像的 `wireview.doneView`），一样是逐字段手写的。
 * 漏一格的表现只在**刷新之后**看得见：实时那一轮 meta 是全的，页面一刷、同一条
 * 消息从补齐路径重建出来，耗时就掉回 0.0s、首字与速率整行消失。2026-08-31 在
 * coding.local 上就是这么撞出来的。
 */
describe("catch-up 的终态帧", () => {
  it("给定日志里的终态帧带本轮统计，当补齐，则一格都不丢", async () => {
    const done: unknown[] = [];
    const { client, socket } = setup({
      onRunResultDone: (frame) => done.push(frame),
    });
    await authenticate(client, socket);

    const caughtUp = client.catchUp(CID, "fp-origin");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const attach = ProtobufRpcCodec.decode(socket.sent[0]);
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        attach.id,
        rpcMethods.sessionAttach,
        {
          conversationId: CID,
          backendType: "codex",
          lifecycleState: "idle",
          latestSeq: 1n,
        },
      ),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const pull = ProtobufRpcCodec.decode(socket.sent[1]);
    socket.receive(
      ProtobufRpcCodec.encodeTypedMethodResponse(
        pull.id,
        rpcMethods.sessionPull,
        {
          notifications: [
            {
              seq: 1n,
              payload: {
                payload: {
                  case: "runResultDone" as const,
                  value: {
                    conversationId: CID,
                    model: "gpt-5.6-sol",
                    turnToken: 1n,
                    durationMs: 7400,
                    firstTokenMs: 7200,
                    tokensPerSec: 0.7,
                  },
                },
              },
            },
          ],
          cursor: 1n,
          hasMore: false,
          oldestSeq: 1n,
        },
      ),
    );

    await expect(caughtUp).resolves.toBeUndefined();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      model: "gpt-5.6-sol",
      durationMs: 7400,
      firstTokenMs: 7200,
      tokensPerSec: 0.7,
    });
  });
});

describe("RelayClient 通道级失败", () => {
  /*
    规格「按对话寻址 · 失败按通道隔离」：单条通道的目标不存在 / 离线 / 转发失败
    改由通道开通应答里的可区分错误码作答，「客户端据此只把那一条通道标为不可达」。

    「标为不可达」有两层，缺一不可：
      1. 状态要说实话。`reconnecting` 在这个宿主里的意思是「有人正在重试」
         （use-relay.ts 的状态注释），而通道级失败之后没有任何人在重试——连接本身
         好得很，服务端只是关掉了这一条。说成 reconnecting 会让页面一直停在
         「正在重连」上，而那条对话其实已经死了。
      2. 它必须重开得起来。用户按「重新连接」走的是 pool.reconnect → 换 socket，
         而被关掉的这条通道已经不在连接的通道表里了，换 socket 带不回它。

    RED 之前：handleChannelClosed 置 reconnecting 且没有任何重开路径，于是这条对话
    在这个标签页里永久死亡，而横幅还在说它在重试。
  */
  it("把被服务端关掉的通道标为不可达，而不是谎称还在重连", async () => {
    const { client, socket } = setup();
    await authenticate(client, socket);
    expect(client.state).toBe("connected");

    // 空载荷 = 服务端关掉了这一条通道（通道级失败的收尾）。
    socket.receive(new Uint8Array(0));

    expect(client.state).toBe("disconnected");
  });

  it("重开被服务端关掉的通道：目标声明重新发出去", async () => {
    const { client, socket } = setup();
    await authenticate(client, socket);
    socket.receive(new Uint8Array(0));

    socket.sent = [];
    void client.reopen();
    await vi.waitFor(() =>
      expect(socket.sent.length).toBeGreaterThanOrEqual(1),
    );
    // 目标声明永远是一条通道的第一帧（决策 10）。
    expect(new TextDecoder().decode(socket.sent[0])).toBe(
      machineTarget("fp-daemon"),
    );
  });
});

/**
 * 连接层的重连纪律（不是通道层的）。
 *
 * 这条常驻连接在登录期间永不释放，所以「连不上」时它会一直重拨下去；退让因此是它
 * 唯一的自我约束。两件事各自会把这个约束抵消掉：
 *
 *  1. 一 `onopen` 就把失败计数归零。服务端接受 upgrade 之后随即断开是一条真实路径
 *     （连接守卫每次心跳复查账号闸门，闸门判不出来时 fail-closed），那时每条连接都在
 *     「连上 → 立刻断 → 等一个 base」上打转，等于对着一个已经不健康的依赖每秒一次，
 *     而且每一轮还各换一张票。
 *  2. 没有抖动。所有标签页看到的是同一次故障，会整整齐齐地同时回来。
 */
describe("RelayConnection 的重连退让", () => {
  function connectionWithSockets(): {
    sockets: BinarySocket[];
    delays: number[];
    fire: () => void;
    connection: RelayConnection;
  } {
    const sockets: BinarySocket[] = [];
    const delays: number[] = [];
    const timers: Array<() => void> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      timers.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const connection = new RelayConnection({
      url: "ws://relay.test/v1/relay/client",
      jwt: "jwt",
      reconnectDelayMs: 1000,
      stableConnectionMs: 10_000,
      random: () => 1,
      createWebSocket: () => {
        const socket = new BinarySocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    return {
      sockets,
      delays,
      fire: () => timers.shift()?.(),
      connection,
    };
  }

  it("连上之后立刻被断开不算一次成功，退让继续增长", async () => {
    const { sockets, delays, fire, connection } = connectionWithSockets();
    const connecting = connection.connect();
    sockets[0].open();
    await connecting;
    // 连上就断（服务端接受 upgrade 之后随即关闭）。
    sockets[0].close();
    expect(delays).toEqual([1000]);

    // 重拨，再来一次同样的「连上就断」。
    fire();
    await Promise.resolve();
    await Promise.resolve();
    sockets[1].open();
    await Promise.resolve();
    sockets[1].close();
    // 计数没有被那次 onopen 抹掉，等待翻倍。
    expect(delays).toEqual([1000, 2000]);
    connection.close();
  });

  it("退让带抖动，不是一个所有标签页共用的定值", async () => {
    const { sockets, delays, connection } = connectionWithSockets();
    const connecting = connection.connect();
    sockets[0].open();
    await connecting;
    connection["opts"].random = () => 0;
    sockets[0].close();
    // 半幅抖动：random=0 取下界。定值实现在这里会给出 1000。
    expect(delays).toEqual([500]);
    connection.close();
  });
});
