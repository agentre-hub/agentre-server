/**
 * 中继客户端 URL 与票据的携带方式。
 *
 * 浏览器原生 WebSocket 设不了 Authorization 头。此前的做法是把票塞进 query，可那样
 * 它会落进 ingress access log、反代日志、浏览器 history 与 Referer —— 一处泄漏就是
 * 一段可用凭据。
 *
 * 而**子协议列表是能设的**（`new WebSocket(url, protocols)` 的第二个参数），它走
 * Sec-WebSocket-Protocol 请求头，不进 URL。所以票改走那里：提两个子协议，
 * `agentre-protobuf` 与 `agentre.bearer.<token>`；服务端的 relayTokenBridge 从提议
 * 列表里取票搬进 Authorization，照常回选前者（后者只是载体，不参与协商）。
 *
 * URL 上现在**什么都不剩**：目标从连接级降到了通道级（决策 10），
 * `daemon_fingerprint` 随之取消，一个账号一条连接，目标由每条虚拟通道自己声明
 * （见 relayTarget）。
 */

/** 携带票据的伪子协议前缀，与服务端 api.bearerSubprotocolPrefix 同源。 */
export const BearerSubprotocolPrefix = "agentre.bearer.";

/** 把一张票包成子协议。 */
export function bearerSubprotocol(accessToken: string): string {
  return `${BearerSubprotocolPrefix}${accessToken}`;
}

export function relayClientUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/v1/relay/client`;
}
