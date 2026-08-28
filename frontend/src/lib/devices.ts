import { api } from "@/lib/api";

/**
 * GET /v1/devices 的响应契约。
 *
 * 这是 internal/api/device.ListDevicesItem 在前端这一侧的唯一一份声明。它曾在
 * Overview / Chat / Devices / SessionDetailView 里各写一份，四份互不相同——
 * 少写的字段不会报错，只会在那个页面上安静地缺一段。device-item-contract.test.ts
 * 逐字段盯着它与 Go 那份对齐，也盯着不许有第二份。
 *
 * 字段全是必填：后端结构体里没有 omitempty，一条设备行永远带齐这十个键。
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
