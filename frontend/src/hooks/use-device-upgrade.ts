import { useEffect, useMemo, useRef } from "react";

import {
  useAgentredUpgrade,
  type AgentredUpgrade,
  type AgentredUpgradePhase,
} from "@agentre-hub/agentre-ui";

import { api } from "@/lib/api";
import { fetchDevices, type DeviceItem } from "@/lib/devices";

/**
 * 控制台这一侧的取数适配（规格 2026-09-03「远程一键升级」+「控制台呈现与 latest
 * 来源」）。
 *
 * 状态机本身归共享包的 `useAgentredUpgrade` —— 两端对同一台机器的同一次升级，看到
 * 的态与它们之间的迁移必须一模一样。这里只把它接到本站这条线上：受理调用走
 * `POST /v1/devices/upgrade`，轮询期间的版本从设备清单上读（devices.version 由镜像
 * 握手成功后写回，是实时的）。
 */
export type UpgradePhase = AgentredUpgradePhase;
export type DeviceUpgrade = AgentredUpgrade;

/** POST /v1/devices/upgrade 的应答（internal/api/device.DeviceUpgradeResponse）。 */
interface UpgradeResponse {
  accepted: boolean;
  reject_reason: string;
  message: string;
  active_turns: number;
  target_version: string;
}

export function useDeviceUpgrade(
  deviceID: number,
  currentVersion: string,
  /** 轮询期间取到的新清单：交给页面，好让卡上的版本跟着变，而不是各存一份。 */
  onDevices?: (devices: DeviceItem[]) => void,
): DeviceUpgrade {
  // onDevices 由页面每次渲染新造一个，进 useMemo 的依赖会让 ports 每渲染一次就换一
  // 个身份。同步放在 effect 里而不是渲染期直接写 ref（渲染期改 ref 是被禁的：那一次
  // 修改对本次渲染不可见，读到什么取决于渲染顺序）。
  const onDevicesRef = useRef(onDevices);
  useEffect(() => {
    onDevicesRef.current = onDevices;
  }, [onDevices]);

  const ports = useMemo(
    () => ({
      requestUpgrade: async (force: boolean) => {
        const result = await api<UpgradeResponse>("/v1/devices/upgrade", {
          method: "POST",
          body: JSON.stringify({ device_id: deviceID, force }),
        });
        return {
          accepted: result.accepted,
          rejectReason: result.reject_reason,
          message: result.message,
          activeTurns: result.active_turns,
          targetVersion: result.target_version,
        };
      },
      readVersion: async () => {
        const list = await fetchDevices();
        onDevicesRef.current?.(list);
        return list.find((d) => d.id === deviceID)?.version;
      },
    }),
    [deviceID],
  );
  return useAgentredUpgrade(currentVersion, ports);
}
