/**
 * 会话视图状态（R11）：四类不可达与失效各自可区分，不折叠成同一个错误。
 *
 * 由纯函数 deriveSessionViewStatus 从底层信号导出，便于 vitest 直接构造各状态断言
 * 文案互不相同（测试接缝 6）。四类状态：
 *   - machineOffline —— 目标 agentred 离线（R11 第 1 类）
 *   - reconnecting / lost / connected —— 浏览器与 server 之间断线（R11 第 2 类，
 *     按既有的 connected / reconnecting / lost 表达）
 *   - revoked —— 本浏览器已被解除授权，须重新登录（R11 第 3 类）
 *   - loggedOut —— 账号已登出（R11 第 4 类）
 *
 * 优先级：账号登出 > 解除授权 > 机器离线 > 中继连接态。优先级由可探测性决定：
 * 账号没了其余全无意义；设备被解除授权后任何注册 / 连接都不该继续；机器离线时
 * 中继必然连不上，没必要先演一段「连接中」。
 */
import type { RelayState } from "@/lib/relayClient";

export type SessionViewStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "lost"
  | "machineOffline"
  | "revoked"
  | "loggedOut";

export interface SessionViewInput {
  /** 中继连接状态（RelayClient.onStateChange 的直接透传）。 */
  relayState: RelayState;
  /** /v1/auth/me 是否有效（false = 账号已登出）。 */
  meValid: boolean;
  /** 本浏览器（kind=web 设备）是否已被解除授权。 */
  webDeviceRevoked: boolean;
  /** 目标 agentred 是否在线；null = 尚未探知。 */
  machineOnline: boolean | null;
}

export function deriveSessionViewStatus(
  input: SessionViewInput,
): SessionViewStatus {
  const { relayState, meValid, webDeviceRevoked, machineOnline } = input;
  if (!meValid) return "loggedOut";
  if (webDeviceRevoked) return "revoked";
  if (machineOnline === false) return "machineOffline";
  switch (relayState) {
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "connecting":
      return "connecting";
    default:
      return "lost";
  }
}
