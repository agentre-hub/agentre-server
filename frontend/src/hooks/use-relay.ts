import type {
  AutonomousTurnStartedFrame,
  TurnStartedFrame,
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
 * 一条**虚拟通道**上的中继客户端：向共用的账号级连接（一个账号一条 socket）借一条
 * 到指定目标的通道，持续暴露它的状态与可用的 RelayClient。
 *
 * 参数是**通道目标**而不是机器指纹：`conversation:<uuid>`（已保存的对话，服务端解析
 * 出承载机器）或 `machine:<fingerprint>`（机器轴、新建对话、未保存的对话），见
 * `@/lib/relayTarget` 的入口分流。断线重连由连接自己负责，本 hook 只做生命周期
 * （卸载时归还租约）。
 *
 * 实时回调经 ref 转发，避免回调闭包读到陈旧 state；页面可以放心传引用 setter。
 */
export interface UseRelayMachineOptions {
  /** 第二个参数是这一帧发生的时刻，见 `NotificationHandlers.onEvent`。 */
  onEvent?: (frame: EventFrame, createtime?: number) => void;
  onRunResultDone?: (frame: RunResultDoneFrame, createtime?: number) => void;
  onAutonomousTurnStarted?: (
    frame: AutonomousTurnStartedFrame,
    createtime?: number,
  ) => void;
  /** 客户端要的那一轮开始了，见 `NotificationHandlers.onTurnStarted`。 */
  onTurnStarted?: (frame: TurnStartedFrame, createtime?: number) => void;
}

export interface UseRelayMachineResult {
  client: RelayClient | null;
  relayState: RelayState;
  relayTicket: RelayTicket | null;
  relayTicketError: unknown;
  /**
   * 对端按协议版本拒了这条通道的握手时，它自己那句说明；没被拒过就是 null。
   *
   * 与 `relayState` 分开报，因为那一格说不出这件事：被拒之后客户端落在
   * "disconnected"（它不再重试了），而那与「票根本没换到」长得一模一样 —— 两者要说
   * 的话和要给的出口完全不同（页面据此走 `protocolMismatch` 而不是 `lost`）。
   */
  handshakeRejection: string | null;
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
  target: string | null,
  opts: UseRelayMachineOptions = {},
): UseRelayMachineResult {
  const [relayTicket, setRelayTicket] = useState<RelayTicket | null>(null);
  const [relayTicketError, setRelayTicketError] = useState<unknown>(null);
  /*
    有目标 = 我们在连。这句话必须在**渲染期**就成立,不能等 effect。

    `target` 只在目标确定之后才非空(设备清单回来、或账号那一行认领落定):它与
    `machineOnline: true` 同时落地,而下面那只 effect 排在渲染之后
    ——中间夹着整整一帧 `{ relayState: "disconnected", machineOnline: true }`,
    `deriveSessionViewStatus` 把它读作「连过又放弃了」,屏幕上闪一条红色的
    「连接已断开,已经不再自动重试」。取票之前那句 `setRelayState("connecting")`
    补不上这一帧:它自己就在 effect 里。

    所以初值按有没有目标给,换目标时用 React 官方的「prop 变化时重置 state」
    渲染期调整模式跟着改(不能在 effect 里裸调 setState —— lint 禁止)。
    "disconnected" 从此只有一种来路:连过又放弃了(close 之后)、或票根本没换到。
  */
  const initialState = (value: string | null): RelayState =>
    value ? "connecting" : "disconnected";
  const [relayState, setRelayState] = useState<RelayState>(() =>
    initialState(target),
  );
  const [handshakeRejection, setHandshakeRejection] = useState<string | null>(
    null,
  );
  const [lastTarget, setLastTarget] = useState(target);
  if (lastTarget !== target) {
    setLastTarget(target);
    setRelayState(initialState(target));
    // 上一台机器的构建版本对不上，不代表下一台也对不上：不清的话，切过去的那一屏
    // 会挂着一条属于别人的横幅，而它那条通道可能好得很。
    setHandshakeRejection(null);
  }
  const [client, setClient] = useState<RelayClient | null>(null);
  /** 兜底的手动重连计数器：变一次就把下面那个 effect 整个重跑一遍。 */
  const [attempt, setAttempt] = useState(0);
  /**
   * 从头再连一次。
   *
   * 首选让**池子**原地换掉那条 socket：这个账号只有一条，上面还跑着别的使用方
   * （目录选择器、派发、别的机器的通道），换 socket 不动通道与引用计数，所以谁都
   * 不会被甩下，手里的 RelayClient 也不换人。单纯把自己这份租约还掉再借一次是没
   * 用的 —— 借回来的还是同一条。
   *
   * 池子里没有这条通道的条目（票根本没换到，连接压根没建出来）时才退回计数器，
   * 让整只 effect 从取票重跑。
   */
  const reconnect = useCallback(() => {
    if (!target) return;
    setRelayState("connecting");
    void relayClientPool
      .reconnect(target)
      .catch(() => false)
      .then((rebuilt) => {
        if (!rebuilt) setAttempt((n) => n + 1);
      });
  }, [target]);
  const optsRef = useRef(opts);
  // 每次渲染后把最新回调收进 ref，避免 RelayClient 持有的回调读到陈旧闭包。
  useEffect(() => {
    optsRef.current = opts;
  });

  useAliveEffect(
    (alive) => {
      if (!target) return;
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
        target,
        {
          onStateChange: setRelayState,
          onHandshakeRejected: setHandshakeRejection,
          onEvent: (frame, at) => optsRef.current.onEvent?.(frame, at),
          onRunResultDone: (frame, at) =>
            optsRef.current.onRunResultDone?.(frame, at),
          onAutonomousTurnStarted: (frame, at) =>
            optsRef.current.onAutonomousTurnStarted?.(frame, at),
          onTurnStarted: (frame, at) =>
            optsRef.current.onTurnStarted?.(frame, at),
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
    [target, attempt],
  );

  return {
    client,
    relayState,
    relayTicket,
    relayTicketError,
    handshakeRejection,
    reconnect,
  };
}
