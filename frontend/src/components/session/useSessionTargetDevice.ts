import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { useAliveEffect } from "@/hooks/use-alive-effect";
import { ApiError } from "@/lib/api";
import { deviceRoster, fetchDevices, type DeviceItem } from "@/lib/devices";

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
 * 所以 useRelayChannel 必须排在取设备之后；而断线原因探测要看它吐出来的
 * relayState，只能再排在中继之后。中间那一层归组件，两头归这里。
 */
export interface SessionTargetDevice {
  device: DeviceItem | null;
  deviceError: unknown;
  /** 那台机器此刻在不在线；还没问出来时是 null（「不知道」，不是「离线」）。 */
  machineOnline: boolean | null;
  /** 浏览器这边的登录会话还有效吗。探测撞上 401 时转 false。 */
  meValid: boolean;
  /** 名单读失败后的「重试」：作废共享名单、重新取一遍（成功即清掉 deviceError）。 */
  retryDevice: () => void;
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
  // 「重试」改的是它：effect 只在回调里写状态，重取靠它换依赖。
  const [round, setRound] = useState(0);
  const retryDevice = useCallback(() => {
    deviceRoster.invalidate();
    setRound((r) => r + 1);
  }, []);

  /*
    换目标机器时先把这一片**清空**，不要等新的取回来再覆盖。

    下面那只 effect 排在渲染之后，中间隔着整整一个往返：不清的话，那一段里屏幕上
    挂的是**上一台**的在线状态、名字与撤销状态，全部记在新目标账上。上一台离线时
    新目标先被扣一顶红色的「机器离线」（横幅里还写着上一台的名字）；反过来（上一台
    在线、新的其实离线）更糟——那一段输入框是可用的，敲进去的话发不出去。

    `machineOnline` 的 null 是「还没问出来」，不是「离线」：`deriveSessionViewStatus`
    早就为它留好了「连接中」那一档，清空即接上那一档。

    `meValid` 不在此列：它是**账号**级的事实，不随目标机器变。
  */
  const [lastDid, setLastDid] = useState(did);
  if (lastDid !== did) {
    setLastDid(did);
    setDevice(null);
    setDeviceError(null);
    setMachineOnline(null);
  }

  // 取设备。换设备时同时重新允许一次 reconnecting 原因探测（R11）——旧设备的探测
  // 结论不属于新设备。
  //
  // 走共享名单：外壳与对话页同一屏上也在要它，没有理由再单独打一遍（规格 2026-11-20
  // 决策 8）。下面的断线探因不走——它要的是这一刻的在线态。
  //
  // 复用来的名单里没有这一台时不当场判「找不到」：它可能是这 10 秒里刚配对的。作废
  // 再取一份新的，用新的下结论——旧名单不能把新事实藏住。
  useAliveEffect(
    (alive) => {
      deviceRoster
        .get()
        .then((list) => {
          if (list.some((d) => d.id === did)) return list;
          deviceRoster.invalidate();
          return deviceRoster.get();
        })
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
    [did, round],
  );

  return {
    retryDevice,
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
