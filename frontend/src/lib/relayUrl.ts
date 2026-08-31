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
 * URL 上只剩 daemon_fingerprint —— 目标指纹不是凭据，它本来就该在那儿
 * （relay_svc.ConnectClient 据此校验目标与在线态）。
 */

/** 携带票据的伪子协议前缀，与服务端 api.bearerSubprotocolPrefix 同源。 */
export const BearerSubprotocolPrefix = "agentre.bearer.";

/** 把一张票包成子协议。 */
export function bearerSubprotocol(accessToken: string): string {
  return `${BearerSubprotocolPrefix}${accessToken}`;
}

export function relayClientUrl(fingerprint: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ daemon_fingerprint: fingerprint });
  return `${proto}//${window.location.host}/v1/relay/client?${params.toString()}`;
}
