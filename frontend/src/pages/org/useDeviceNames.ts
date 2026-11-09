/**
 * 设备 id → 账号级显示名（备注名优先，见 `deviceDisplayName`）。
 *
 * 组织读接口给执行目标带的是设备自报名（`device_name`），备注名只在 `/v1/devices`
 * 里；手机索引的第二行要写「机器 · 后端」，机器写的是用户认得的那个名字。取不到
 * （请求失败 / 还没回来）时返回空表，调用方回落到自报名——索引不因此变空。
 */
import * as React from "react";

import { fetchDevices, deviceDisplayName } from "@/lib/devices";

export function useDeviceNames(enabled: boolean): ReadonlyMap<number, string> {
  const [names, setNames] = React.useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchDevices()
      .then((devices) => {
        if (alive)
          setNames(new Map(devices.map((d) => [d.id, deviceDisplayName(d)])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  return names;
}
