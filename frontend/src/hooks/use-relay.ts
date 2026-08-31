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
   * **不是**在旧 client 上重试。`relayState` 走到 "disconnected" 只有两条来历，
   * 两条都没有可重试的东西：`RelayClient.close()` 已经被调用过（`handleClose` 里
   * `closedByUser` 那一支），或者票根本没换到、client 压根没建出来。自动重连那
   * 一路停在 "reconnecting"，永远不落到 "disconnected"。唯一能做的就是换一个。
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
  /*
    有目标机器 = 我们在连。这句话必须在**渲染期**就成立,不能等 effect。

    `fingerprint` 是 `device?.online ? device.fingerprint : null`:设备清单回来
    那一拍,指纹与 `machineOnline: true` 同时落地,而下面那只 effect 排在渲染之后
    ——中间夹着整整一帧 `{ relayState: "disconnected", machineOnline: true }`,
    `deriveSessionViewStatus` 把它读作「连过又放弃了」,屏幕上闪一条红色的
    「连接已断开,已经不再自动重试」。取票之前那句 `setRelayState("connecting")`
    补不上这一帧:它自己就在 effect 里。

    所以初值按有没有目标机器给,换目标时用 React 官方的「prop 变化时重置 state」
    渲染期调整模式跟着改(不能在 effect 里裸调 setState —— lint 禁止)。
    "disconnected" 从此只有一种来路:连过又放弃了(close 之后)、或票根本没换到。
  */
  const initialState = (fp: string | null): RelayState =>
    fp ? "connecting" : "disconnected";
  const [relayState, setRelayState] = useState<RelayState>(() =>
    initialState(fingerprint),
  );
  const [lastFingerprint, setLastFingerprint] = useState(fingerprint);
  if (lastFingerprint !== fingerprint) {
    setLastFingerprint(fingerprint);
    setRelayState(initialState(fingerprint));
  }
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
      // 取票是连接的第一步,不是连接之前的准备:这一步期间还没有 RelayClient,
      // 没人会把状态推离初值 "disconnected",而那个值被 deriveSessionViewStatus
      // 读作「连过又放弃了」= lost。于是刷新页面后第一次打开对话,整个取票往返
      // 都盖在红色终态横幅「已经不再自动重试」底下 —— 而它正是最有进展的时候。
      // 这里在发请求前就把话说对:我们在连。
      setRelayState("connecting");
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
          if (!alive()) return;
          setRelayTicketError(e);
          // 票都没换到就没有自动重连可言(RelayClient 压根没建出来)。退回
          // "disconnected" 让页面走「lost + 重新连接」那一档 —— 否则上面那句
          // "connecting" 会把一次彻底的失败永远显示成转圈。
          setRelayState("disconnected");
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
