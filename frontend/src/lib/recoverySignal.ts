/**
 * 「恢复信号」（规格 2026-11-25 K3）：网络可能回来了，此刻是重试失败读的好时机。
 *
 * 三条来路，一个出口：
 *
 *  - 网络恢复：`online`；
 *  - 回到前台：`visibilitychange` 转为可见、`pageshow`（含 bfcache 恢复）——后台里
 *    请求多半撞上了死连接，回来时网络往往已经好了；
 *  - 执行端通道重连：由持有那条连接状态的一侧调 `noteRecovery()`（见
 *    use-account-channel）。这里不去认识连接，免得 lib 反过来依赖 hook。
 *
 * 页面藏在后台时不喊：那时重试换不来任何人看得见的东西，转为可见那一下会再喊。
 *
 * 只说「可能好了」，不说该做什么：读失败的那几处各自经 `useRetryOnRecovery`
 * 决定要不要重试、几条信号挤在一起时只试一次。DOM 上只挂一份监听，有订阅者时才挂。
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let detach: (() => void) | null = null;

function hidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/** 有一条恢复信号。页面在后台时不算数。 */
export function noteRecovery(): void {
  if (hidden()) return;
  // 复制一份再遍历：某个订阅者的重试可能同步卸载掉别的订阅者。
  for (const listener of [...listeners]) listener();
}

function attach(): void {
  if (detach || typeof window === "undefined") return;
  const onSignal = () => noteRecovery();
  window.addEventListener("online", onSignal);
  window.addEventListener("pageshow", onSignal);
  document.addEventListener("visibilitychange", onSignal);
  detach = () => {
    window.removeEventListener("online", onSignal);
    window.removeEventListener("pageshow", onSignal);
    document.removeEventListener("visibilitychange", onSignal);
  };
}

/** 订阅恢复信号，交回退订。最后一个走了就把 DOM 监听拆掉。 */
export function subscribeRecovery(listener: Listener): () => void {
  listeners.add(listener);
  attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detach?.();
      detach = null;
    }
  };
}
