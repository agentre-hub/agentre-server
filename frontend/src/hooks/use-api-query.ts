import {
  useEffect,
  useState,
  type DependencyList,
  type Dispatch,
  type SetStateAction,
} from "react";

import { api } from "@/lib/api";

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

/** useApiQuery 的返回值。 */
export interface ApiQuery<T> {
  data: T | null;
  loading: boolean;
  /** 失败时一定是真值，见实现处说明；没失败时是 null。 */
  error: unknown;
  /**
   * 就地改这份数据：删掉一行、乐观插入。导出它是因为调用方几乎总要改——不导出
   * 的话每个调用方都得再复制一份 useState 把它抄进去，等于没抽。
   */
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * useApiQuery 取一个只读端点，把「挂载守卫 + loading + error」这一套收成一份。
 *
 * path 传 null 表示这次不该取（条件取数）：不发请求，loading 也直接是 false——
 * 停在 loading 上会让条件不满足的页面永远显示骨架。
 *
 * 需要 Promise.all、需要走中继而不是 HTTP、或者成功之后还要做别的事的地方，直接
 * 用上面的 useAliveEffect：那些形状各不相同，硬套一个取数 hook 只会多一层壳。
 */
export function useApiQuery<T>(
  path: string | null,
  deps: DependencyList = [],
): ApiQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<unknown>(null);

  useAliveEffect(
    (alive) => {
      if (path === null) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      api<T>(path)
        .then((got) => {
          if (alive()) setData(got);
        })
        .catch((e: unknown) => {
          // 一律存真值：调用方按 `error ? 错误态 : 骨架` 渲染，而 reject(undefined)
          // 是存在的（一个空的 catch、一次 abort）。原样存进去会让页面永远停在骨架上。
          if (alive()) setError(e ?? new Error(`${path} 请求失败`));
        })
        .finally(() => {
          if (alive()) setLoading(false);
        });
    },
    [path, ...deps],
  );

  return { data, loading, error, setData };
}
