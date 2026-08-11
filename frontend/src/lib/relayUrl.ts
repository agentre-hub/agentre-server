/**
 * 中继客户端 URL 构造（T6 解决 T5 的 open concern：浏览器原生 WebSocket 无法设置
 * Authorization 头）。设备 JWT 放进 query 的 access_token，服务端 queryTokenBridge
 * 把它搬到 Authorization 头复用既有的 DeviceJWT 校验。daemon_fingerprint 指明目标
 * agentred（relay_svc.ConnectClient 据此校验目标与在线态）。
 */
export function relayClientUrl(
  fingerprint: string,
  accessToken: string,
): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    daemon_fingerprint: fingerprint,
    access_token: accessToken,
  });
  return `${proto}//${window.location.host}/v1/relay/client?${params.toString()}`;
}
