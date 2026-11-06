import { rpcMethods } from "@agentre-hub/agentre-wire";
import { useCallback, useState, type RefObject } from "react";

import type { RelayClient } from "@/lib/relayClient";

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
  // 在渲染期按上一次的 running 调整，而不是在 effect 里补一帧。
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

  return { stop, stopping: running && stoppingSid === sid };
}
