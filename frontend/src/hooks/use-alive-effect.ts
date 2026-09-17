import { useEffect, type DependencyList } from "react";

/**
 * useAliveEffect 跑一个异步任务，并保证「这一轮已经不算数了」的时候它的回调不再
 * 写状态——组件卸载了，或者依赖变了、这一轮被下一轮取代了。
 *
 * 这段守卫此前在 24 个 effect 里各写一遍（`let alive = true` + 结尾的
 * `return () => { alive = false }`），横跨 12 个文件。漏掉它不会报错，只会在两种时候咬人：卸载
 * 之后 setState（React 的警告，且是一次泄漏），以及慢响应把已经过期的那一轮结果
 * 盖到新一轮上（取数竞态——切了范围又切回来，看到的是上一次的数据）。
 *
 * 回调收到的是 `alive()` 这个函数而不是布尔值：布尔值会被闭包定死在调用那一刻，
 * 而这里要问的恰恰是「现在还算不算数」。
 */
export function useAliveEffect(
  run: (alive: () => boolean) => void | (() => void),
  deps: DependencyList,
): void {
  useEffect(() => {
    let alive = true;
    const cleanup = run(() => alive);
    return () => {
      alive = false;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方给全，run 每次渲染都是新函数、不能进依赖
  }, deps);
}
