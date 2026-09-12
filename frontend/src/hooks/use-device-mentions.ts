import { useState } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";
import { fetchDevices, type DeviceItem } from "@/lib/devices";

/** 交给共享包 `buildMentionSources` 第三个入参的形状。 */
export interface DeviceMentionItem {
  fp: string;
  name: string;
  online: boolean;
}

/**
 * 账号下的机器投影成 `@` 菜单要的清单。
 *
 * 指纹是设备提及在正文里的唯一身份（共享包的 `MentionRef.fp`）—— 消息会被别的
 * 机器读到，那时候只有指纹还指得回同一台。没有指纹的行因此整条不列：与其发一个
 * `fp=""` 的空壳，不如它不在菜单里。
 *
 * 这一端没有「本机」那一档：浏览器不是一台机器（桌面端才有，见那边的
 * `buildDeviceMentionItems`）。
 */
export function toDeviceMentionItems(
  devices: DeviceItem[],
): DeviceMentionItem[] {
  return devices
    .filter((d) => d.fingerprint)
    .map((d) => ({ fp: d.fingerprint, name: d.name, online: d.online }));
}

/**
 * `@` 菜单里那份设备清单（服务端这一侧）。
 *
 * 取一次就够：菜单里的在线态是一枚装饰点，提及是上下文引用而不是派发决定
 * （设备页仍然是实时的）。拉失败就是空清单 —— 设备那一组不出现，`@` 的其余部分
 * 照常。
 */
export function useDeviceMentions(): DeviceMentionItem[] {
  const [devices, setDevices] = useState<DeviceMentionItem[]>([]);

  useAliveEffect((alive) => {
    fetchDevices()
      .then((list) => {
        if (alive()) setDevices(toDeviceMentionItems(list));
      })
      .catch(() => {});
  }, []);

  return devices;
}
