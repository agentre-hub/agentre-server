import { api } from "@/lib/api";

/**
 * GET /v1/devices 的响应契约。
 *
 * 这是 internal/api/device.ListDevicesItem 在前端这一侧的唯一一份声明。它曾在
 * Overview / Chat / Devices / SessionDetailView 里各写一份，四份互不相同——
 * 少写的字段不会报错，只会在那个页面上安静地缺一段。device-item-contract.test.ts
 * 逐字段盯着它与 Go 那份对齐，也盯着不许有第二份。
 *
 * 字段全是必填：后端结构体里没有 omitempty，一条设备行永远带齐这十三个键。
 */
export interface DeviceItem {
  id: number;
  name: string;
  kind: string;
  platform: string;
  version: string;
  fingerprint: string;
  last_seen_at: number;
  status: number;
  online: boolean;
  is_this_device: boolean;
  /**
   * 上一次镜像握手是不是被那台机器判定协议版本不合而拒绝（server 按 (账号, 机器)
   * 记的共享状态）。设备卡据此出「版本太旧」的强提示，而不是一句泛泛的连不上。
   */
  protocol_mismatch: boolean;
  /**
   * 那台机器最近一次镜像握手自报的短 commit。空串 = 非发布构建（开发构建）——
   * 只有 `daemon_build_known` 为真时这层含义才成立。
   */
  daemon_commit: string;
  /**
   * server 到底知不知道那台机器跑的是哪个构建（至少成功握过一次手）。为假时
   * `daemon_commit` 的空串表示「不知道」而不是「开发构建」，卡上因此不下任何判断。
   */
  daemon_build_known: boolean;
}

/**
 * 取账号下的设备清单。
 *
 * 这是前端唯一直接打 `/v1/devices` 的地方。此前有 11 处各自 `api<{devices: X}>`，
 * 其中三处还自带一份更窄的别名（AppShell 的 DeviceRow、Settings 与 enginePorts
 * 各一个 DeviceDTO）——同一份契约漂移换了个名字接着漂。
 *
 * 不做缓存也不去重：调用方各有各的重取时机（在线态信号、页面切换、手动刷新），
 * 收在这里只会变成另一层要维护的失效判据。
 */
export async function fetchDevices(): Promise<DeviceItem[]> {
  const res = await api<{ devices?: DeviceItem[] }>("/v1/devices");
  return res.devices ?? [];
}
