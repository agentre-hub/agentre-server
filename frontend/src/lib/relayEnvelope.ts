/**
 * 中继通道信封：2 字节大端通道 ID 长度 + 通道 ID（UTF-8）+ 载荷。
 *
 * 与服务端 `relay_svc.WrapEnvelope` / `UnwrapEnvelope` 同一个格式，两条链路共用。
 * 目标下沉到通道之后（决策 10），客户端那条连接上同时跑着多条通道，因此它也开始
 * 收发信封，而不再是裸载荷。
 *
 * 空载荷是合法的：它是「这条通道关了」的信号。
 */

const CHANNEL_ID_MAX = (1 << 16) - 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function wrapEnvelope(channelId: string, frame: Uint8Array): Uint8Array {
  const id = encoder.encode(channelId);
  if (id.length === 0) throw new Error("relay: 通道 ID 不能为空");
  if (id.length > CHANNEL_ID_MAX) throw new Error("relay: 通道 ID 过长");
  const envelope = new Uint8Array(2 + id.length + frame.length);
  envelope[0] = (id.length >> 8) & 0xff;
  envelope[1] = id.length & 0xff;
  envelope.set(id, 2);
  envelope.set(frame, 2 + id.length);
  return envelope;
}

export function unwrapEnvelope(envelope: Uint8Array): {
  channelId: string;
  frame: Uint8Array;
} {
  if (envelope.length < 2) throw new Error("relay: 信封比通道长度还短");
  const length = (envelope[0] << 8) | envelope[1];
  if (envelope.length < 2 + length) throw new Error("relay: 信封被截断");
  return {
    channelId: decoder.decode(envelope.subarray(2, 2 + length)),
    frame: envelope.subarray(2 + length),
  };
}

/** 把 WebSocket 收到的东西归一成字节。 */
export function binaryPayload(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("relay: 中继帧必须是二进制");
}
