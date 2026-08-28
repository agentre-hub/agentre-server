import type {
  AutonomousTurnStartedFrame,
  EventFrame,
  RunResultDoneFrame,
} from "@agentre-hub/agentre-wire";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";
import { RelayClient, type RelayState } from "@/lib/relayClient";
import { relayClientUrl } from "@/lib/relayUrl";
import { ensureRelayTicket, type RelayTicket } from "@/lib/relayTicket";

/**
 * 一台 agentred 的中继连接：用登录 session 换短效 ticket → 连 /v1/relay/client →
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
  relayTicket: RelayTicket | null;
  relayTicketError: unknown;
  /**
   * 从头再连一次：重取 ticket、新建 RelayClient、connect。
   *
   * **不是**在旧 client 上重试。`relayState` 走到 "disconnected" 只有一条来历
   * ——`RelayClient.close()` 已经被调用过（`handleClose` 里 `closedByUser` 那一支）：
   * 自动重连那一路停在 "reconnecting"，永远不落到 "disconnected"。一个已经
   * closed 的 client 上没有可重试的东西，唯一能做的就是换一个。
   *
   * 页面据此给「lost」那一档一个真的出路 —— 横幅说的是「已经不再自动重试」，
   * 那句话必须配一个按钮，否则用户只能刷新整页而界面没说。
   */
  reconnect: () => void;
}

export function useRelayMachine(
  fingerprint: string | null,
  opts: UseRelayMachineOptions = {},
): UseRelayMachineResult {
  const [relayTicket, setRelayTicket] = useState<RelayTicket | null>(null);
  const [relayTicketError, setRelayTicketError] = useState<unknown>(null);
  const [relayState, setRelayState] = useState<RelayState>("disconnected");
  const [client, setClient] = useState<RelayClient | null>(null);
  /** 手动重连的计数器：变一次就把下面那个 effect 整个重跑一遍。 */
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const optsRef = useRef(opts);
  // 每次渲染后把最新回调收进 ref，避免 RelayClient 持有的回调读到陈旧闭包。
  useEffect(() => {
    optsRef.current = opts;
  });

  useAliveEffect(
    (alive) => {
      if (!fingerprint) return;
      let c: RelayClient | null = null;
      ensureRelayTicket()
        .then((ticket) => {
          if (!alive()) return;
          setRelayTicket(ticket);
          c = new RelayClient({
            url: relayClientUrl(fingerprint, ticket.accessToken),
            jwt: ticket.accessToken,
            deviceFingerprint: ticket.clientId,
            refreshCredentials: async () => {
              const fresh = await ensureRelayTicket();
              return {
                url: relayClientUrl(fingerprint, fresh.accessToken),
                jwt: fresh.accessToken,
              };
            },
            onStateChange: setRelayState,
            onEvent: (frame) => optsRef.current.onEvent?.(frame),
            onRunResultDone: (frame) =>
              optsRef.current.onRunResultDone?.(frame),
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
          if (alive()) setRelayTicketError(e);
        });
      return () => {
        c?.close();
      };
      // attempt 变化即「用户按了重新连接」：清理跑一遍（旧 client close），
      // 再从取 ticket 开始整条重来。
    },
    [fingerprint, attempt],
  );

  return { client, relayState, relayTicket, relayTicketError, reconnect };
}
