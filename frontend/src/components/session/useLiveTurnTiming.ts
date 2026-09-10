import { useCallback, useEffect, useRef, useState } from "react";

import {
  advanceLiveTurn,
  beginLiveTurn,
  type LiveTurnTiming,
} from "@/components/session/liveTurnTiming";

/** 详情视图从这一只拿到的东西。 */
export interface LiveTurnClock {
  /** 交给转录的那份计时。不计时的轮次是 null。 */
  timing: LiveTurnTiming | null;
  /**
   * 开表：一轮刚由**这个浏览器**开起来（自己发送开新一轮 / 自主续轮）。
   *
   * 由知道这件事的那一处直接说出来，不从状态里反推：`turnActive` 转真的来路有三条
   * （自己开轮、自主续轮、接进来时对端已经在跑），只有前两条算「起点观察得到」。
   */
  beginTurn: (startedAt: number) => void;
  /**
   * 接进来那一刻对端在不在跑（attach 按清单快照定的那一格）。
   *
   * 在跑，而上一屏又交过开轮时刻（草稿页刚派发），就拿它开表；否则这一轮不计时。
   * 必须排在补齐**之后**调用 —— 补齐会把历史里的终态帧回放一遍，落在前面刚开的表
   * 会被上一轮的结束收掉（与 `markTurnActive` 同一条理由，两者就摆在一起）。
   */
  noteAttachedTurn: (active: boolean) => void;
  /** 来了一帧。只认帧的 kind —— 计时不关心载荷。 */
  noteFrame: (kind: string | undefined) => void;
  /** 轮次结束：终态帧自带的那一份比这里数出来的准，表就此收掉。 */
  endTurn: () => void;
  /** 目标会话换了。 */
  reset: () => void;
}

/**
 * 交过来的那个开轮时刻还算不算数。
 *
 * 导航 state 会跟着那条历史记录一直留着：十分钟后刷新页面它还在手上，而此刻在跑的
 * 多半已经是后面某一轮了。派发到装载中间只隔一次导航，超出这个窗口的一律当过期 ——
 * 判错的代价是不画那一格（回到「一轮跑完才出数」），而拿过期时刻开表会画出一个
 * 「已经跑了十分钟」，比不画更糟。
 */
const SEEDED_START_MAX_AGE_MS = 30_000;

/**
 * 一轮跑起来之后那条 meta 的计时。
 *
 * 为什么要有它：耗时、首字与 tok/s 在 wire 上**只出现在终态帧**（见 turnDone），
 * 而那一帧要等一轮跑完才来。不自己数，跑的那几十秒里那一格只能是死的 —— 桌面端
 * 从 `chat-streams-store` 上摘同样的四个数交给同一个组件，这里是本站的那一半。
 *
 * 一轮的**起点观察不到就不开表**：接进来时对端已经在跑（轮次中途刷新、或别的端
 * 开的轮）时，这一轮什么时候开的本站不知道 —— wire 上带 `started_at` 的只有会话级
 * 与导入用的结构。从接进来那一刻起表会给出一个偏小、却看着与真的一样的数。
 */
export function useLiveTurnTiming(seededStartedAt?: number): LiveTurnClock {
  const [timing, setTiming] = useState<LiveTurnTiming | null>(null);
  // 帧回调不在渲染里,读不到上面那个 state 的最新值(它捕获的是上一次渲染的闭包),
  // 所以计时另存一份 ref;两者一律经 write 一起写。
  const timingRef = useRef<LiveTurnTiming | null>(null);

  const write = useCallback((next: LiveTurnTiming | null) => {
    timingRef.current = next;
    setTiming(next);
  }, []);

  // 上一屏交过来的那个开轮时刻。存一份 ref 是为了让下面 noteAttachedTurn 的身份稳定
  // ——它要进 attach effect 的依赖表,每渲染换一个会让整条接入流程重跑一遍。
  const seededRef = useRef(seededStartedAt);
  useEffect(() => {
    seededRef.current = seededStartedAt;
  }, [seededStartedAt]);

  // 开表要赶在首帧之前:一轮跑起来到第一帧回来之间可以隔很久,而那一段正是用户最想
  // 知道「等了多久」的时候(共享包 waitingFirstToken 那一支画的就是它)。
  //
  // 已经在计时就不重开:一轮之内这只会被叫一次,但补齐回放与重连都可能让同一件事
  // 说第二遍,重开等于把已经走了半分钟的表拨回零。
  const beginTurn = useCallback(
    (startedAt: number) => {
      if (timingRef.current != null) return;
      write(beginLiveTurn(startedAt));
    },
    [write],
  );

  const noteAttachedTurn = useCallback(
    (active: boolean) => {
      if (!active) return;
      const seeded = seededRef.current;
      if (seeded == null || Date.now() - seeded > SEEDED_START_MAX_AGE_MS)
        return;
      beginTurn(seeded);
    },
    [beginTurn],
  );

  const noteFrame = useCallback(
    (kind: string | undefined) => {
      const next = advanceLiveTurn(timingRef.current, kind, Date.now());
      if (next !== timingRef.current) write(next);
    },
    [write],
  );

  const endTurn = useCallback(() => write(null), [write]);

  // 收表与重置落到同一件事（都回到「不计时」），但两处说的不是一回事，各留一个名字。
  return {
    timing,
    beginTurn,
    noteAttachedTurn,
    noteFrame,
    endTurn,
    reset: endTurn,
  };
}
