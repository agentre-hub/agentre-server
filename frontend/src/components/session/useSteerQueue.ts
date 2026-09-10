import {
  adoptSteerHandle,
  clearSteerQueue,
  consumeSteers,
  dropSteers,
  emptySteerQueue,
  enqueueSteer,
  markSteerNotCancellable,
  type ConsumedSteerRef,
  type QueuedItem,
  type SteerQueueState,
} from "@agentre-hub/agentre-ui";
import { useCallback, useState } from "react";

/**
 * 这一轮里排着的那几条插话（规格 2026-09-08-console-steer-queue）。
 *
 * 状态迁移全在共享包的 steer-queue 那份纯归约里，两端同一套规矩；这只 hook 只做
 * 宿主自己那两件事：**按 (设备, 会话) 持有**，以及轮末被丢弃的那几条暂存在哪。
 *
 * 队列是**这一屏本地的乐观状态**：协议上没有「列出未消费 steer」这一问，所以别的
 * 端排进去的消息在被消费之前这里看不见（消费事件到时它的句柄对不上任何一条 chip，
 * 归约会原样放过）。
 */
export interface SteerQueue {
  /** 此刻排着的那几条。 */
  items: QueuedItem[];
  /** 轮末没被取走、暂存起来等用户处置的那几条；空 = 没有。 */
  dropped: QueuedItem[];
  /** 提交那一刻先挂上去（本地句柄，还不可撤销）。 */
  enqueue: (localId: string, text: string) => void;
  /** 应答回来了：换成执行端认的那个句柄。空句柄 = 对端还没升级，留在降级档。 */
  adopt: (
    localId: string,
    handle: { queuedId: string; cancellable: boolean },
  ) => void;
  /** 后端取走了这几条（`steer_consumed`）。 */
  consume: (consumed: ConsumedSteerRef[]) => void;
  /** 撤回成功、或这条根本没发出去。 */
  drop: (ids: string[]) => void;
  /** 撤回被对端拒了：这条留在原位、转成撤不掉，并挂上对端那句话。 */
  refuseCancel: (id: string, note?: string) => void;
  /** 一轮结束：还剩的挪进 dropped 等用户处置，不静默清掉。 */
  endTurn: () => void;
  /** 用户把被丢弃的那几条领回去了（或选择丢弃）。 */
  clearDropped: () => void;
  /** 换了会话：整份重来。 */
  reset: () => void;
}

/**
 * 队列与「被丢弃的那一份」放在**同一格 state** 里。
 *
 * 拆成两格的话，轮末那一步（把还剩的挪进 dropped 再清空队列）就得在一个 setState
 * 的更新函数里调另一个 setState —— 更新函数会被 React 重跑（StrictMode 下必然），
 * 而那是个副作用。一格里一次算完，它就还是个纯函数。
 */
type QueueWithDropped = {
  queue: SteerQueueState;
  dropped: QueuedItem[];
};

const EMPTY: QueueWithDropped = { queue: emptySteerQueue, dropped: [] };

export function useSteerQueue(): SteerQueue {
  const [state, setState] = useState<QueueWithDropped>(EMPTY);

  const update = useCallback(
    (fn: (queue: SteerQueueState) => SteerQueueState) => {
      setState((prev) => {
        const queue = fn(prev.queue);
        return queue === prev.queue ? prev : { ...prev, queue };
      });
    },
    [],
  );

  const enqueue = useCallback(
    (localId: string, text: string) => {
      update((queue) => enqueueSteer(queue, { id: localId, text }));
    },
    [update],
  );

  const adopt = useCallback(
    (localId: string, handle: { queuedId: string; cancellable: boolean }) => {
      update((queue) => adoptSteerHandle(queue, localId, handle));
    },
    [update],
  );

  const consume = useCallback(
    (consumed: ConsumedSteerRef[]) => {
      if (consumed.length === 0) return;
      update((queue) => consumeSteers(queue, consumed));
    },
    [update],
  );

  const drop = useCallback(
    (ids: string[]) => {
      update((queue) => dropSteers(queue, ids));
    },
    [update],
  );

  const refuseCancel = useCallback(
    (id: string, note?: string) => {
      update((queue) => markSteerNotCancellable(queue, id, note));
    },
    [update],
  );

  /*
    轮末残留不静默清掉：用户刚敲完的那段字凭空消失、且无从补救，比多一条横幅糟得多
    （规格决策 4）。已经有一份暂存着时不覆盖——那一份还等着用户处置。
  */
  const endTurn = useCallback(() => {
    setState((prev) => {
      if (prev.queue.items.length === 0) return prev;
      return {
        queue: clearSteerQueue(prev.queue),
        dropped: prev.dropped.length > 0 ? prev.dropped : prev.queue.items,
      };
    });
  }, []);

  const clearDropped = useCallback(
    () =>
      setState((prev) =>
        prev.dropped.length === 0 ? prev : { ...prev, dropped: [] },
      ),
    [],
  );

  const reset = useCallback(() => setState(EMPTY), []);

  return {
    items: state.queue.items,
    dropped: state.dropped,
    enqueue,
    adopt,
    consume,
    drop,
    refuseCancel,
    endTurn,
    clearDropped,
    reset,
  };
}

/**
 * 从一帧 `steer_consumed` 里取出「后端取走了哪几条」。
 *
 * 载荷形状是 wire 的 `ConsumedSteer`（`queued_id` / `text` / 来源两格），经中继的
 * Protobuf → 视图事件那一跳之后是小驼峰。取不出数组时交回空表：这一帧说不出任何
 * 条目，就什么都不消费——按文本乱猜会把别人排的那条算到自己头上。
 */
export function consumedSteerRefs(event: unknown): ConsumedSteerRef[] {
  const steers = (event as { steers?: unknown } | undefined)?.steers;
  if (!Array.isArray(steers)) return [];
  return steers.map((steer) => {
    const s = steer as { queuedId?: unknown; text?: unknown };
    return {
      queuedId: typeof s.queuedId === "string" ? s.queuedId : undefined,
      text: typeof s.text === "string" ? s.text : undefined,
    };
  });
}
