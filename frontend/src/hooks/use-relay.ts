import type {
  AutonomousTurnStartedFrame,
  EventFrame,
  RunResultDoneFrame,
} from "@agentre-hub/agentre-wire";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";
import type { RelayClient, RelayState } from "@/lib/relayClient";
import {
  acquireRelayClient,
  relayClientPool,
  type RelayLease,
} from "@/lib/relayClientPool";
import type { RelayTicket } from "@/lib/relayTicket";

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
  /** 兜底的手动重连计数器：变一次就把下面那个 effect 整个重跑一遍。 */
  const [attempt, setAttempt] = useState(0);
  /**
   * 从头再连一次。
   *
   * 首选让**池子**原地重建那条连接：这台机器上可能还有别的使用方（目录选择器、
   * 派发）搭在同一条上，它们靠 `onClient` 跟着换手，不会被甩下。单纯把自己这份
   * 租约还掉再借一次是没用的 —— 借回来的还是池子里那条坏的。
   *
   * 池子里没有这台机器的条目（票根本没换到，连接压根没建出来）时才退回计数器，
   * 让整只 effect 从取票重跑。
   */
  const reconnect = useCallback(() => {
    if (!fingerprint) return;
    setRelayState("connecting");
    void relayClientPool
      .reconnect(fingerprint)
      .catch(() => false)
      .then((rebuilt) => {
        if (!rebuilt) setAttempt((n) => n + 1);
      });
  }, [fingerprint]);
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
      let lease: RelayLease | null = null;
      // waitForConnect:false —— 拿到 client 就挂上去，首次连不上交给 RelayClient
      // 自己退避重连，页面靠 relayState 的 reconnecting 去探测原因（R11）。等连上
      // 再交付会把这条路堵死：首次失败当场被说成 disconnected。
      acquireRelayClient(
        fingerprint,
        {
          onStateChange: setRelayState,
          onEvent: (frame) => optsRef.current.onEvent?.(frame),
          onRunResultDone: (frame) => optsRef.current.onRunResultDone?.(frame),
          onAutonomousTurnStarted: (frame) =>
            optsRef.current.onAutonomousTurnStarted?.(frame),
          // 池子重建这条连接（手动重连）时跟着换手里这一个。
          onClient: setClient,
        },
        { waitForConnect: false },
      )
        .then((acquired) => {
          if (!alive()) {
            acquired.release();
            return;
          }
          lease = acquired;
          setRelayTicket(acquired.ticket);
          setClient(acquired.client);
        })
        .catch((e: unknown) => {
          if (!alive()) return;
          setRelayTicketError(e);
          // 走到这里只有一种来路：票没换到（waitForConnect:false 不看握手成败）。
          // 没有票就没有自动重连可言。退回 "disconnected" 让页面走「lost + 重新
          // 连接」那一档 —— 否则上面那句 "connecting" 会把一次彻底的失败永远显示
          // 成转圈。
          setRelayState("disconnected");
        });
      return () => {
        // 还回去，不是关掉：同一台机器上目录选择器 / 派发可能正搭着这一条。
        lease?.release();
      };
      // attempt 变化即「池子里压根没有这台机器的条目、只能整条重来」，见 reconnect。
    },
    [fingerprint, attempt],
  );

  return { client, relayState, relayTicket, relayTicketError, reconnect };
}
