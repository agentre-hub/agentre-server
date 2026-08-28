import {
  PROTOCOL_VERSION,
  ProtobufRpcCodec,
  encodeRpcCancel,
  rpcMethods,
} from "@agentre-hub/agentre-wire";
import { describe, expect, it, vi } from "vitest";

import { RelayClient, type RelayClientOptions } from "@/lib/relayClient";

class BinarySocket {
  readyState = 0;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: unknown): void {
    this.sent.push(data as Uint8Array);
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
    this.onmessage?.({ data });
  }
}

function setup(overrides: Partial<RelayClientOptions> = {}): {
  client: RelayClient;
  socket: BinarySocket;
  protocols: string[];
} {
  const socket = new BinarySocket();
  const protocols: string[] = [];
  const options: RelayClientOptions = {
    url: "ws://relay.test/v1/relay/client",
    jwt: "jwt",
    deviceFingerprint: "fp-web",
    reconnect: false,
    createWebSocket: (_url, _headers, offered) => {
      protocols.push(...offered);
      return socket as unknown as WebSocket;
    },
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
    expect(protocols).toEqual(["agentre-protobuf"]);

    const list = client.request(rpcMethods.sessionList, {});
    const pull = client.request(rpcMethods.sessionPull, {
      sessionId: 7n,
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
    const failed = client.request(rpcMethods.sessionAttach, { sessionId: 9n });
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
          sessionId: 7,
          seq: 1,
          event: { case: "textDelta", text: "hello" },
        },
      }),
    );
    await vi.waitFor(() =>
      expect(events).toEqual([
        { sessionId: 7, seq: 1, event: { kind: "text_delta", text: "hello" } },
      ]),
    );
  });
});
