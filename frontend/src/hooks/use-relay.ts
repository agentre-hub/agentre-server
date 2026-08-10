import { useEffect, useRef, useState } from "react";

import { RelayClient, type RelayState } from "@/lib/relayClient";
import { relayClientUrl } from "@/lib/relayUrl";
import { ensureWebDevice, type WebDevice } from "@/lib/webDevice";
import type {
  AutonomousTurnStartedFrame,
  EventFrame,
  RunResultDoneFrame,
} from "@/lib/wire";

/**
 * 一台 agentred 的中继连接：确保浏览器设备身份 → 以设备 JWT 连 /v1/relay/client →
 * 持续暴露连接状态与可用的 RelayClient。断线自动重连由 RelayClient 自己负责，
 * 本 hook 只做生命周期（卸载时 close）。
 *
 * 实时回调经 ref 转发，避免回调闭包读到陈旧 state；页面可以放心传引用 setter。
 */
export interface UseRelayMachineOptions {
  onEvent?: (frame: EventFrame) => void;
  onRunResultDone?: (frame: RunResultDoneFrame) => void;
  onAutonomousTurnStarted?: (frame: AutonomousTurnStartedFrame) => void;
}

export interface UseRelayMachineResult {
  client: RelayClient | null;
  relayState: RelayState;
  webDevice: WebDevice | null;
  /** ensureWebDevice 失败（含 WebDeviceRevokedError）。 */
  webDeviceError: unknown;
}

export function useRelayMachine(
  fingerprint: string | null,
  opts: UseRelayMachineOptions = {},
): UseRelayMachineResult {
  const [webDevice, setWebDevice] = useState<WebDevice | null>(null);
  const [webDeviceError, setWebDeviceError] = useState<unknown>(null);
  const [relayState, setRelayState] = useState<RelayState>("disconnected");
  const [client, setClient] = useState<RelayClient | null>(null);
  const optsRef = useRef(opts);
  // 每次渲染后把最新回调收进 ref，避免 RelayClient 持有的回调读到陈旧闭包。
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    if (!fingerprint) return;
    let alive = true;
    let c: RelayClient | null = null;
    ensureWebDevice()
      .then((dev) => {
        if (!alive) return;
        setWebDevice(dev);
        c = new RelayClient({
          url: relayClientUrl(fingerprint, dev.accessToken),
          jwt: dev.accessToken,
          onStateChange: setRelayState,
          onEvent: (frame) => optsRef.current.onEvent?.(frame),
          onRunResultDone: (frame) => optsRef.current.onRunResultDone?.(frame),
          onAutonomousTurnStarted: (frame) =>
            optsRef.current.onAutonomousTurnStarted?.(frame),
        });
        setClient(c);
        void c.connect().catch(() => {
          // 首次连接失败：RelayClient 已进入自动重连，这里不打断——页面靠
          // relayState 的 reconnecting 去探测原因（R11）。
        });
      })
      .catch((e: unknown) => {
        if (alive) setWebDeviceError(e);
      });
    return () => {
      alive = false;
      c?.close();
    };
  }, [fingerprint]);

  return { client, relayState, webDevice, webDeviceError };
}
