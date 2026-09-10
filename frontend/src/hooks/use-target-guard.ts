import { useCallback, useEffect, useRef } from "react";

/**
 * 「这一次异步做完之后，目标还是它吗」——由**事件回调**发起的那一族的守卫。
 *
 * `useAliveEffect` 的 `alive()` 只管得住 effect 发起的那些：依赖一变，React 跑清理
 * 函数，那一轮就此作废。而发消息、往回读一页、翻索引的下一页都是用户点出来的，
 * 没有清理函数可挂；与此同时右栏与索引都是**同实例换 props**（没有 key 强制重挂），
 * 于是一次在飞的请求解析时，页面上打开的很可能已经是另一条会话、另一个范围。
 *
 * 少了这道守卫的后果不是「多一次没用的渲染」，而是**内容落到别人身上**：A 的发送
 * 失败会在 B 下面长出一条带 A 文本的气泡（点它的重试真的把 A 的话发进 B）、A 的
 * 旧消息会前插进 B 的转录、上一个筛选的那一页会追加到新筛选的列表下面。
 *
 * 用法与 `alive()` 同形，两步：
 *
 * ```ts
 * const guard = useTargetGuard(`${did}|${sid}`);
 * async function send() {
 *   const stillHere = guard();       // 发请求那一刻**捕获**目标
 *   const res = await request();
 *   if (!stillHere()) return;        // 解析时比对：已经换人就一个字都不写
 * }
 * ```
 *
 * 捕获与比对都读同一份 ref，而它由 effect 在每次提交后写：捕获发生在事件回调 /
 * 异步续段里，那时提交早已结束，ref 里就是此刻真正打开的那个目标。渲染期既不读
 * 也不写它（`react-hooks/refs` 明令禁止）。
 */
export function useTargetGuard(target: string): () => () => boolean {
  const currentRef = useRef(target);
  useEffect(() => {
    currentRef.current = target;
  }, [target]);
  // 恒定引用：它会被列进 useCallback 的依赖（loadEarlier / loadMore），换一次身份
  // 就等于让那些回调也跟着换，而它们的身份又是别处 effect 的依赖。
  return useCallback(() => {
    const captured = currentRef.current;
    return () => currentRef.current === captured;
  }, []);
}
