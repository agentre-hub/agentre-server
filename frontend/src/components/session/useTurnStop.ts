import { rpcMethods } from "@agentre-hub/agentre-wire";
import { useCallback, useState, type RefObject } from "react";

import type { RelayClient } from "@/lib/relayClient";
import type { SessionViewStatus } from "@/lib/sessionView";

/**
 * 停止请求此刻发不发得出去 —— 头部与输入框两颗停止键共用这一条判据。
 *
 * 只有连上了才发得出去：其余各档里真实客户端会当场以「连接未就绪」拒掉，按下去
 * 等于空按。头部那颗据此禁用；共享输入框没有「停止键禁用」这一档，据此不摆停止键
 * （提交位还给发送）。
 */
export function stopReachable(status: SessionViewStatus): boolean {
  return status === "connected";
}

export interface UseTurnStopOptions {
  clientRef: RefObject<RelayClient | null>;
  /** 发起端指纹：与 run / steer 一样，abort 也要带回 origin。 */
  originRef: RefObject<string | undefined>;
  sid: string;
  /** 这一轮在不在跑。它落回 false 即回合结束，停止中随之复位。 */
  running: boolean;
}

export interface TurnStop {
  /** 把这一轮停下来（wire 的 runtime.abort）。 */
  stop: () => Promise<void>;
  /** 已经点了停止、这一轮还没结束。头部与输入框两颗停止键共用这一格。 */
  stopping: boolean;
  /**
   * 这一轮的终态到了：放下停止中。宿主在终态通知里调用。
   *
   * 不能只靠 `running` 的翻转：补齐把一页通知在同一个同步循环里应用，「这一轮结束」
   * 与「下一轮开始」并进同一次渲染时 running 一次都不落回 false，停止中会挂到新一轮上。
   */
  turnEnded: () => void;
}

/**
 * 这一条会话的「停止」：头部那颗与输入框提交位那颗共用的宿主状态（规格 2026-11-06
 * A2，桌面端 use-chat-actions 的 doStop / stopping 同一套口径）。
 *
 * 停止请求返回**不等于**这一轮已经停了 —— 终态帧稍后才到。所以停止中从按下去一直
 * 挂到 `running` 落回 false；只有请求本身失败时才当场放开（这一轮的实时流照常继续，
 * 状态自己说话，不另开一条错误面）。按会话记：右栏同实例换 props 时，切到别的会话
 * 不会把那边也显示成在停。
 */
export function useTurnStop({
  clientRef,
  originRef,
  sid,
  running,
}: UseTurnStopOptions): TurnStop {
  /** 点了停止的那条会话。 */
  const [stoppingSid, setStoppingSid] = useState<string | null>(null);

  // 回合结束（running 落回 false）就放下停止中：下一轮开起来时不能还挂着上一轮的。
  // 在渲染期按上一次的 running 调整，而不是在 effect 里补一帧。终态通知另由
  // turnEnded 直接放下（见那里）；这一条兜的是换会话的复位与 attach 快照那几条路。
  const [prevRunning, setPrevRunning] = useState(running);
  if (running !== prevRunning) {
    setPrevRunning(running);
    if (!running) setStoppingSid(null);
  }

  const stop = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setStoppingSid(sid);
    try {
      await c.request(rpcMethods.runtimeAbort, {
        conversationId: sid,
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      });
    } catch {
      // 停不下来不另开一条错误面：这一轮的实时流会照常继续，状态自己说话。
      // 只把停止键放开，让人还能再按一次。
      setStoppingSid((cur) => (cur === sid ? null : cur));
    }
  }, [clientRef, originRef, sid]);

  const turnEnded = useCallback(() => setStoppingSid(null), []);

  return { stop, stopping: running && stoppingSid === sid, turnEnded };
}
