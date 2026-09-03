import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { fetchDevices, type DeviceItem } from "@/lib/devices";

/**
 * 「点了一键升级之后发生了什么」的全部状态机（规格 2026-09-03「远程一键升级」
 * +「控制台呈现与 latest 来源」）。
 *
 * 受理只回一个布尔，升级过程本身不可观察 —— daemon 受理之后就会重启，server 到那台
 * 机器的镜像连接会断。因此这里从**版本号的变化**推断结果：轮询设备清单（它的
 * version 由镜像握手成功后写回，是实时的），变了就是成功，5 分钟内没变就按超时失败
 * 呈现（决策 6/7 的已知代价：没有监管者的形态升级后不会自己回来）。
 *
 * 活跃轮次拒绝（决策 8/21）不是失败，是需要显式越过的一道闸：主动作不禁用，只是
 * 文案改口（呈现层做），这里只负责在用户点了「仍要升级」之后打开确认、并且只有
 * 确认之后才真的把 force=true 发出去 —— 重试绝不能被读成默许。
 */
export type UpgradePhase =
  | { kind: "idle" }
  /** 活跃轮次拒绝：message 逐字来自 daemon（与 `agentred update` 同一句话，决策 22）。 */
  | {
      kind: "active-turns";
      message: string;
      activeTurns: number;
      confirmOpen: boolean;
    }
  | { kind: "upgrading"; fromVersion: string; targetVersion: string }
  | { kind: "success"; fromVersion: string; toVersion: string }
  | { kind: "timeout" }
  /** 已是最新 / 进行中 / 路径不可写 / 下载校验失败，以及调用本身失败。 */
  | { kind: "failed"; message: string };

/** POST /v1/devices/upgrade 的应答（internal/api/device.DeviceUpgradeResponse）。 */
interface UpgradeResponse {
  accepted: boolean;
  reject_reason: string;
  message: string;
  active_turns: number;
  target_version: string;
}

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 5 * 60 * 1000;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DeviceUpgrade {
  phase: UpgradePhase;
  /** 点「升级 agentred」：不带 force，机器空闲时这一次就够了。 */
  start: () => void;
  /** 点「仍要升级」：只打开确认，不发出任何调用。 */
  requestForce: () => void;
  /** 确认框的「稍后再说」：退回等待确认前的那个态，不清掉拒绝原因。 */
  cancelForce: () => void;
  /** 确认框的「仍然升级」：这一步之后 force=true 才真的出现在请求里。 */
  confirmForce: () => void;
}

export function useDeviceUpgrade(
  deviceID: number,
  currentVersion: string,
  /** 轮询期间取到的新清单：交给页面，好让卡上的版本跟着变，而不是各存一份。 */
  onDevices?: (devices: DeviceItem[]) => void,
): DeviceUpgrade {
  const [phase, setPhase] = useState<UpgradePhase>({ kind: "idle" });
  const pollRef = useRef<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  // 每次 start/confirmForce 都作废前一次还在飞的调用与轮询：一个迟到的应答不该把
  // 界面从「刚刚重新点了一次」的状态拽回去。
  const attemptRef = useRef(0);
  // onDevices 由页面每次渲染新造一个，进依赖会让轮询每渲染一次重开一遍；同步放在
  // effect 里而不是渲染期直接写 ref（渲染期改 ref 是被禁的：那一次修改对本次渲染
  // 不可见，读到什么取决于渲染顺序）。
  const onDevicesRef = useRef(onDevices);
  useEffect(() => {
    onDevicesRef.current = onDevices;
  }, [onDevices]);

  const stopTimers = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (deadlineRef.current !== null) {
      window.clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      attemptRef.current += 1;
      stopTimers();
    };
  }, [stopTimers]);

  const beginPolling = useCallback(
    (attempt: number, fromVersion: string) => {
      pollRef.current = window.setInterval(() => {
        fetchDevices()
          .then((list) => {
            if (attempt !== attemptRef.current) return;
            onDevicesRef.current?.(list);
            const mine = list.find((d) => d.id === deviceID);
            if (mine && mine.version && mine.version !== fromVersion) {
              stopTimers();
              setPhase({
                kind: "success",
                fromVersion,
                toVersion: mine.version,
              });
            }
          })
          .catch(() => {
            // daemon 正在重启：轮询期间取数失败是这段时间的常态，不能拿一次探测
            // 失败就提前判定失败 —— 判据只有「5 分钟内版本变没变」这一条。
          });
      }, POLL_INTERVAL_MS);
      deadlineRef.current = window.setTimeout(() => {
        if (attempt !== attemptRef.current) return;
        stopTimers();
        setPhase({ kind: "timeout" });
      }, TIMEOUT_MS);
    },
    [deviceID, stopTimers],
  );

  const call = useCallback(
    (force: boolean) => {
      stopTimers();
      attemptRef.current += 1;
      const attempt = attemptRef.current;
      const fromVersion = currentVersion;
      api<UpgradeResponse>("/v1/devices/upgrade", {
        method: "POST",
        body: JSON.stringify({ device_id: deviceID, force }),
      })
        .then((result) => {
          if (attempt !== attemptRef.current) return;
          if (result.accepted) {
            setPhase({
              kind: "upgrading",
              fromVersion,
              targetVersion: result.target_version ?? "",
            });
            beginPolling(attempt, fromVersion);
            return;
          }
          if (result.reject_reason === "active_turns") {
            setPhase({
              kind: "active-turns",
              message: result.message ?? "",
              activeTurns: result.active_turns ?? 0,
              confirmOpen: false,
            });
            return;
          }
          setPhase({ kind: "failed", message: result.message ?? "" });
        })
        .catch((e: unknown) => {
          if (attempt !== attemptRef.current) return;
          setPhase({ kind: "failed", message: messageOf(e) });
        });
    },
    [beginPolling, currentVersion, deviceID, stopTimers],
  );

  return {
    phase,
    start: () => call(false),
    requestForce: () =>
      setPhase((p) =>
        p.kind === "active-turns" ? { ...p, confirmOpen: true } : p,
      ),
    cancelForce: () =>
      setPhase((p) =>
        p.kind === "active-turns" ? { ...p, confirmOpen: false } : p,
      ),
    confirmForce: () => call(true),
  };
}
