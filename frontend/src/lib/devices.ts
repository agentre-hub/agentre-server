import { api } from "@/lib/api";

/**
 * GET /v1/devices 的响应契约。
 *
 * 这是 internal/api/device.ListDevicesItem 在前端这一侧的唯一一份声明。它曾在
 * Overview / Chat / Devices / SessionDetailView 里各写一份，四份互不相同——
 * 少写的字段不会报错，只会在那个页面上安静地缺一段。device-item-contract.test.ts
 * 逐字段盯着它与 Go 那份对齐，也盯着不许有第二份。
 *
 * 字段全是必填：后端结构体里没有 omitempty，一条设备行永远带齐这十四个键。
 */
export interface DeviceItem {
  id: number;
  /** 设备 claim 时自报的名字（通常是主机名）。它归设备所有，每次重新配对会被覆盖。 */
  name: string;
  /**
   * 用户给这台设备起的**账号级**备注名，空串 = 没起过。
   *
   * 同一台电脑上的几个 checkout 在账号里就是几行同名设备；这一格是唯一分得清谁是谁
   * 的东西，而且它是账号级的——控制台、桌面端、任何一端看到的都是同一个名字。
   * 显示用 deviceDisplayName()，不要直接读这一格。
   */
  display_name: string;
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

/**
 * 这一行到底叫什么：用户设过备注名就用它，没设就回落到设备自报名。
 *
 * 回落规则在服务端也写了一遍（device_entity.EffectiveName），两边是同一条：服务端拿它
 * 答改名端点「这一改之后生效的显示名」，前端拿它渲染。之所以不由服务端直接合成一格
 * 发过来，是因为改名对话框要同时拿到两者——自报名当占位符、备注名当输入框的当前值，
 * 合成之后就再也分不出「没设过」和「设成了和主机名一样」。
 */
export function deviceDisplayName(d: {
  name: string;
  display_name?: string;
}): string {
  return d.display_name?.trim() || d.name;
}

/**
 * 设/改/清一台设备的账号级备注名，交回这一改之后**生效**的显示名。
 *
 * 空串（或只有空白）= 清空，生效的显示名回落到设备自报名。
 */
export async function renameDevice(
  id: number,
  displayName: string,
): Promise<string> {
  const res = await api<{ display_name: string }>(`/v1/devices/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ display_name: displayName }),
  });
  return res.display_name;
}
