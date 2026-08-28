import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";
import { ApiError } from "@/lib/api";
import { fetchDevices, type DeviceItem } from "@/lib/devices";

/**
 * 「这条会话跑在哪台机器上、它此刻还够不够得着」这一片状态。
 *
 * 从 SessionDetailView 里搬出来的：那个组件两千多行，取数与渲染缠在一起，而这四
 * 个值（device / deviceError / machineOnline / meValid）只由本文件写，组件其余
 * 部分一律只读——是那个文件里边界最干净的一片。
 *
 * 搬出来的收益是这些边界条件终于测得动：抖动后错误要清掉、断线原因只探一次、
 * 探测撞上 401 要判会话失效。它们此前只能靠把整个详情页渲染出来间接碰到。
 *
 * 拆成两个 hook 是被调用顺序逼的，不是风格：中继连的是 device.fingerprint，
 * 所以 useRelayMachine 必须排在取设备之后；而断线原因探测要看它吐出来的
 * relayState，只能再排在中继之后。中间那一层归组件，两头归这里。
 */
export interface SessionTargetDevice {
  device: DeviceItem | null;
  deviceError: unknown;
  /** 那台机器此刻在不在线；还没问出来时是 null（「不知道」，不是「离线」）。 */
  machineOnline: boolean | null;
  /** 浏览器这边的登录会话还有效吗。探测撞上 401 时转 false。 */
  meValid: boolean;
  /** 交给 useReconnectProbe 的把手，调用方只管原样传过去。 */
  probe: ProbeHandle;
}

export interface ProbeHandle {
  setMachineOnline: Dispatch<SetStateAction<boolean | null>>;
  setMeValid: Dispatch<SetStateAction<boolean>>;
}

export function useSessionTargetDevice(did: number): SessionTargetDevice {
  const [device, setDevice] = useState<DeviceItem | null>(null);
  const [deviceError, setDeviceError] = useState<unknown>(null);
  const [machineOnline, setMachineOnline] = useState<boolean | null>(null);
  const [meValid, setMeValid] = useState(true);

  // 取设备。换设备时同时重新允许一次 reconnecting 原因探测（R11）——旧设备的探测
  // 结论不属于新设备。
  useAliveEffect(
    (alive) => {
      fetchDevices()
        .then((list) => {
          if (!alive()) return;
          const found = list.find((d) => d.id === did);
          if (found) {
            setDevice(found);
            setMachineOnline(found.online);
            // 上一次取数失败（网络抖动）留下的错误必须清掉：不清的话，嵌入右栏
            // 从那次失败起永久卡在错误态——之后切到哪台机器、取数多成功都只显示
            // 旧错误，只能整页刷新救回。
            setDeviceError(null);
          } else {
            setDeviceError(new Error("device not found"));
          }
        })
        .catch((e: unknown) => {
          if (alive()) setDeviceError(e);
        });
    },
    [did],
  );

  return {
    device,
    deviceError,
    machineOnline,
    meValid,
    probe: { setMachineOnline, setMeValid },
  };
}

/**
 * 首次进入 reconnecting（= 连接失败）时探测原因（R11），每台机器只探一次。
 *
 * 「探过了」记的是**探的哪一台**而不是一个布尔：换设备时旧设备的探测结论不属于
 * 新设备，得重新允许一次。记设备号就不必再从外面把标志位拨回去。
 *
 * 带 alive 守卫：reconnecting 期间切换目标设备或卸载时，旧设备那次还在路上的
 * 探测不得把 machineOnline / meValid 覆盖成旧目标（或卸载后）的结论。
 */
export function useReconnectProbe(
  probe: ProbeHandle,
  did: number,
  relayState: string,
): void {
  const probedFor = useRef<number | null>(null);
  useAliveEffect(
    (alive) => {
      if (relayState !== "reconnecting" || probedFor.current === did) return;
      probedFor.current = did;
      fetchDevices()
        .then((list) => {
          if (!alive()) return;
          probe.setMachineOnline(
            list.find((d) => d.id === did)?.online ?? null,
          );
        })
        .catch((e: unknown) => {
          if (!alive()) return;
          if (e instanceof ApiError && e.status === 401)
            probe.setMeValid(false);
        });
    },
    // probe 不进依赖：它每次渲染都是新对象，进去会让 effect 每帧重跑，而它装的
    // 两个 setState 本来就是稳定的。
    [relayState, did],
  );
}
