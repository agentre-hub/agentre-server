import { ProtobufRpcCodec } from "@agentre-hub/agentre-wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RelayClient } from "@/lib/relayClient";
import type {
  RelayChannelHandle,
  RelayChannelListener,
  RelayState,
} from "@/lib/relayConnection";
import { machineTarget } from "@/lib/relayTarget";

/**
 * 对端按**协议版本**拒绝这条通道的握手（daemon 的 `requireProtocolVersion`，
 * `rpcerror.CodeProtocolVersion` = -32006）。
 *
 * 与「换票失败 / 票过期」那一族（见 relay-handshake-credential.test.ts）刻意分开，
 * 因为它们不是同一件事：那些下一次就可能好了，所以退让重试是对的；而**同一个
 * agentred 二进制不会自己变新**，按秒重试永远换不来别的答案。
 *
 * 这条线上真出过：`make agentred-deploy` 把 agentred 抬到新协议、而控制台还是上一次
 * 构建的 bundle 时，两边的版本窗口不再相交（本轮 wireversion 的
 * `MinSupported == Protocol`，窗口是个单点，差一个小版本就出局）。此前浏览器把这一
 * 拒绝折进 `reconnecting`——一个对页面承诺「会自己回来」的瞬态档——于是详情页头部
 * 那枚芯片永远转圈：不说原因（daemon 回的那句话把两边版本都写出来了）、不给出路
 * （「重新连接」按钮只属于 `lost` 那一档），而账号那条 socket 好得很，左下角还是绿的。
 *
 * 服务端一侧对同一个错误码早就是这么办的（agentre-server 的
 * `mirror_svc/protocol_mismatch.go`：单列的哨兵 + 30 分钟退避），这一族用例把浏览器
 * 这一侧对齐到同一条纪律。
 */

/** 只实现 RelayClient 用得到的那一小块连接能力，并把通道的收件口留在手里。 */
class FakeConnection {
  state: RelayState = "connected";
  listener: RelayChannelListener | null = null;
  sent: Uint8Array[] = [];

  connect(): Promise<void> {
    return Promise.resolve();
  }

  openChannel(
    _target: string,
    listener: RelayChannelListener,
  ): RelayChannelHandle {
    this.listener = listener;
    return {
      send: (frame: Uint8Array) => {
        this.sent.push(frame);
      },
      close: () => {},
    };
  }
}

/** 这条通道上已经发出去的 auth.account 次数。 */
function handshakeCount(connection: FakeConnection): number {
  return connection.sent.filter((frame) => {
    const decoded = ProtobufRpcCodec.decode(frame);
    return (
      decoded.body.case === "typedMethodRequest" &&
      decoded.body.method === "authAccount"
    );
  }).length;
}

/**
 * RpcFrame{id, error:{code, message}} 的 canonical Protobuf bytes。
 *
 * wire 包只让**应答端**编错误帧（`ProtobufRpcCodec.encode` 撞上 error 直接抛），而这
 * 条假连接演的正是应答端，所以按线格式手写：RpcFrame.id = 1(varint)、
 * RpcFrame.error = 5、RpcError.code = 1(int32 varint)、RpcError.message = 2(string)。
 * code 是 int32，负值按 64 位补码编成 varint —— daemon 的错误码全是负数。
 *
 * 与 relay-client-protobuf.test.ts 里那一份同形：两个文件各演各的假对端，把它抬进
 * 共用助手要先给测试助手建一个模块，收益还不抵那一步。
 */
function encodeRpcErrorFrame(
  id: bigint,
  code: number,
  message: string,
): Uint8Array {
  const varint = (value: bigint): number[] => {
    const out: number[] = [];
    let rest = value;
    do {
      let byte = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest > 0n) byte |= 0x80;
      out.push(byte);
    } while (rest > 0n);
    return out;
  };
  const text = new TextEncoder().encode(message);
  const error = [
    0x08,
    ...varint(BigInt.asUintN(64, BigInt(code))),
    0x12,
    ...varint(BigInt(text.length)),
    ...text,
  ];
  return new Uint8Array([
    0x08,
    ...varint(id),
    0x2a,
    ...varint(BigInt(error.length)),
    ...error,
  ]);
}

/** daemon 那句话的原文：`wireversion.Reject` 把两边的窗口都写进去了。 */
const REJECTION =
  "peer speaks protocol version 0.3.0, this build accepts protocol versions 0.4.0 to 0.4.0";

/** 用一帧 -32006 拒掉还没应答的那一次 auth.account。 */
function rejectHandshake(connection: FakeConnection, code = -32006): void {
  const pending = connection.sent
    .map((frame) => ProtobufRpcCodec.decode(frame))
    .filter(
      (frame) =>
        frame.body.case === "typedMethodRequest" &&
        frame.body.method === "authAccount",
    );
  const last = pending[pending.length - 1];
  expect(last, "还没有 auth.account 发出去").toBeTruthy();
  connection.listener?.onFrame?.(encodeRpcErrorFrame(last.id, code, REJECTION));
}

function setup(): {
  client: RelayClient;
  connection: FakeConnection;
  rejections: string[];
} {
  const connection = new FakeConnection();
  const rejections: string[] = [];
  const client = new RelayClient({
    connection,
    target: machineTarget("fp-daemon"),
    credential: () => "ticket-1",
    onHandshakeRejected: (detail) => rejections.push(detail),
  });
  return { client, connection, rejections };
}

describe("对端按协议版本拒绝这条通道的握手", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("不再重试：同一个二进制不会自己变新，按秒重拨换不来别的答案", async () => {
    const { client, connection } = setup();

    const connecting = client.connect();
    await vi.waitFor(() => expect(handshakeCount(connection)).toBe(1));
    rejectHandshake(connection);
    await expect(connecting).rejects.toThrow();

    // 退让封顶 30 秒；推过封顶的四倍都不该再有第二次握手。
    await vi.advanceTimersByTimeAsync(120_000);
    expect(handshakeCount(connection)).toBe(1);
  });

  it("不停在 reconnecting：那一档对页面的承诺是「有人正在重试」，而这里没有人在重试", async () => {
    const { client, connection } = setup();

    const connecting = client.connect();
    await vi.waitFor(() => expect(handshakeCount(connection)).toBe(1));
    rejectHandshake(connection);
    await expect(connecting).rejects.toThrow();

    expect(client.state).not.toBe("reconnecting");
    // "disconnected" 是这个宿主里「连过又放弃了」那一格。落在它上面，即便宿主忘了
    // 接下面那一路原因，页面也退化成带「重新连接」按钮的 lost，而不是永远转圈。
    expect(client.state).toBe("disconnected");
  });

  it("把 daemon 的原话交出去：那句话里写着两边各自的版本窗口", async () => {
    const { client, connection, rejections } = setup();

    const connecting = client.connect();
    await vi.waitFor(() => expect(handshakeCount(connection)).toBe(1));
    rejectHandshake(connection);
    await expect(connecting).rejects.toThrow();

    expect(rejections).toEqual([REJECTION]);
  });

  it("别的握手失败照旧退让重试：只有版本这一档是不可能自愈的", async () => {
    const { client, connection } = setup();

    const connecting = client.connect();
    await vi.waitFor(() => expect(handshakeCount(connection)).toBe(1));
    // -32603 内部错误：下一次可能就好了（daemon 刚起、库还没开），必须继续重试。
    rejectHandshake(connection, -32603);
    await expect(connecting).rejects.toThrow();

    expect(client.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(handshakeCount(connection)).toBe(2);
  });
});
