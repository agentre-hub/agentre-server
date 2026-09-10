/**
 * 中继信封在本宿主这一侧剩下的东西。
 *
 * 格式本身与它的校验归 `@agentre-hub/agentre-wire` 的 `relay-envelope` 所有:同一个
 * 信封在 daemon、本仓服务端与浏览器三处跑,从前三份手写解析、三套校验互不相同,本侧
 * 那份最松 —— 自报长度 0 照收(通道 ID 成空串、整段载荷当帧交出去),非法 UTF-8 被
 * TextDecoder 静默换成 U+FFFD。中继上的每一帧都是别的设备发来的字节。
 *
 * 留在这里的只有 binaryPayload:那是浏览器 WebSocket 的平台细节,不是协议。
 */
export { unwrapEnvelope, wrapEnvelope } from "@agentre-hub/agentre-wire";

/** 把 WebSocket 收到的东西归一成字节。 */
export function binaryPayload(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("relay: 中继帧必须是二进制");
}
