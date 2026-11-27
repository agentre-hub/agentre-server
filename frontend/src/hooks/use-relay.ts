import type {
  AutonomousTurnStartedFrame,
  TurnStartedFrame,
  EventFrame,
  RunResultDoneFrame,
} from "@agentre-hub/agentre-wire";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAliveEffect } from "@/hooks/use-alive-effect";
import { RedialTimer } from "@/lib/redialTimer";
import { backoffDelay } from "@/lib/relayBackoff";
import type { RelayClient, RelayState } from "@/lib/relayClient";
import {
  acquireRelayClient,
  relayClientPool,
  type RelayLease,
  type RelayListener,
} from "@/lib/relayClientPool";
import { isSignedOutError } from "@/lib/relayConnection";
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
export interface UseRelayChannelOptions {
  /** 第二个参数是这一帧发生的时刻，见 `NotificationHandlers.onEvent`。 */
  onEvent?: (frame: EventFrame, createtime?: number) => void;
  /** 预览帧那一路（逐 token 呈现），见 `NotificationHandlers.onPreviewEvent`。 */
  onPreviewEvent?: (frame: EventFrame, createtime?: number) => void;
  onRunResultDone?: (frame: RunResultDoneFrame, createtime?: number) => void;
  onAutonomousTurnStarted?: (
    frame: AutonomousTurnStartedFrame,
    createtime?: number,
  ) => void;
  /** 客户端要的那一轮开始了，见 `NotificationHandlers.onTurnStarted`。 */
  onTurnStarted?: (frame: TurnStartedFrame, createtime?: number) => void;
}

export interface UseRelayChannelResult {
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
   * 下一次自动重试排在哪个时刻（Unix 毫秒）；没排着时是 null。界面据此画
   * 「下次自动重试 N 秒后」。来源是这条通道（连接重拨 / 握手重试 / 通道重开），或
   * 票没换到时本 hook 自己排的那次重取。
   *
   * 本 hook 总会给出这一格；声明成可选只是为了既有的页面替身（不给即读作 null）。
   */
  nextRetryAt?: number | null;
  /**
   * 立即再试一次（「立即重试」），排着的那次作废、倒计时从头算。
   *
   * 首选让池子把那条 socket 原地换掉；票都没换到时从取票重来。
   *
   * 自动重试那一路停在 "reconnecting"（网络错误永不进终态）；"disconnected" /
   * "signedOut" 是终态，那里没有人在重试，这颗按钮是唯一的出路。
   */
  reconnect: () => void;
}

export function useRelayChannel(
  target: string | null,
  opts: UseRelayChannelOptions = {},
): UseRelayChannelResult {
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
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const [lastTarget, setLastTarget] = useState(target);
  if (lastTarget !== target) {
    setLastTarget(target);
    setRelayState(initialState(target));
    setNextRetryAt(null);
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
    setNextRetryAt(null);
    void relayClientPool
      .reconnect(target)
      // 换连接失败（取票 5xx / 401）由连接自己落成退避重试或登出态，并经通道报上来；
      // 这里再整只重跑只会多借一次租约。
      .catch(() => true)
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
      /** 票没换到时自己排的那次重取，见下面的 catch。 */
      const retry = new RedialTimer();
      let failures = 0;
      // waitForConnect:false —— 拿到 client 就挂上去，首次连不上交给 RelayClient
      // 自己退避重连，页面靠 relayState 的 reconnecting 去探测原因（R11）。等连上
      // 再交付会把这条路堵死：首次失败当场被说成 disconnected。
      const listener: RelayListener = {
        onStateChange: setRelayState,
        onHandshakeRejected: setHandshakeRejection,
        onNextRetryAt: setNextRetryAt,
        onEvent: (frame, at) => optsRef.current.onEvent?.(frame, at),
        onPreviewEvent: (frame, at) =>
          optsRef.current.onPreviewEvent?.(frame, at),
        onRunResultDone: (frame, at) =>
          optsRef.current.onRunResultDone?.(frame, at),
        onAutonomousTurnStarted: (frame, at) =>
          optsRef.current.onAutonomousTurnStarted?.(frame, at),
        onTurnStarted: (frame, at) =>
          optsRef.current.onTurnStarted?.(frame, at),
      };
      const tryAcquire = () => {
        acquireRelayClient(target, listener, { waitForConnect: false })
          .then((acquired) => {
            if (!alive()) {
              acquired.release();
              return;
            }
            lease = acquired;
            setRelayTicket(acquired.ticket);
            setRelayTicketError(null);
            setClient(acquired.client);
          })
          .catch((e: unknown) => {
            if (!alive()) return;
            setRelayTicketError(e);
            // 走到这里只有一种来路：票没换到（waitForConnect:false 不看握手成败），
            // 于是还没有连接替我们重试。401 是终态（已登出）；其余——网络错误、超时、
            // 5xx——只是这一次没成，自己退避再取，永不进终态（E1）。
            if (isSignedOutError(e)) {
              setNextRetryAt(null);
              setRelayState("signedOut");
              return;
            }
            const delay = backoffDelay(failures, {
              baseMs: 1000,
              capMs: 30_000,
            });
            failures += 1;
            setRelayState("reconnecting");
            setNextRetryAt(Date.now() + delay);
            retry.schedule(delay, () => {
              if (!alive()) return;
              setNextRetryAt(null);
              setRelayState("connecting");
              tryAcquire();
            });
          });
      };
      /*
        联网、回到前台时立即重试（规格 E「网络恢复（online）、回到前台时立即重试」）。
        连接建出来之后这件事归池子的前台监听（RelayClientPool.watchForeground）；票都
        没换到时还没有连接，那份监听也还没装上，所以退避中的这一段由这里自己听。
        只在排着重取时才动：取票途中再取一次只是多发一个请求。
      */
      const retryNow = () => {
        if (!alive() || !retry.pending) return;
        if (document.visibilityState === "hidden") return;
        retry.cancel();
        setNextRetryAt(null);
        setRelayState("connecting");
        tryAcquire();
      };
      window.addEventListener("online", retryNow);
      window.addEventListener("pageshow", retryNow);
      document.addEventListener("visibilitychange", retryNow);
      tryAcquire();
      return () => {
        window.removeEventListener("online", retryNow);
        window.removeEventListener("pageshow", retryNow);
        document.removeEventListener("visibilitychange", retryNow);
        retry.cancel();
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
    nextRetryAt,
    reconnect,
  };
}
