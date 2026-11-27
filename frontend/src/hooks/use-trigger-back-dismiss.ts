import { useCallback, useSyncExternalStore } from "react";

import { useBackDismiss } from "@/hooks/use-back-dismiss";

/**
 * 共享包的模型选择器把开关收在自己里面、不对外报，而系统返回要关它得先知道它开着
 * （规格 2026-11-25 D1）：触发器的 aria-expanded 就是它对外的事实，订阅它
 * （MutationObserver）比往包里加一个只为本站用的受控入参便宜。
 *
 * 关法是点一下触发器（Radix 的触发器就是开关），走选择器自己的关闭路径。不用合成
 * Esc——选择器在搜索框有字时把 Esc 当「先清空」吃掉，弹层不关，而历史上那一条记号
 * 已经退掉了，下一次返回就会直接离开页面。
 *
 * `root` 是包住选择器的元素，`triggerTestId` 是选择器触发器的 data-testid。返回弹层
 * 此刻开着没有。桌面宽度 useBackDismiss 自己不碰历史。
 */
export function useTriggerBackDismiss(
  root: HTMLElement | null,
  triggerTestId: string,
  enabled = true,
): boolean {
  const trigger = useCallback(
    () =>
      root?.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`) ??
      null,
    [root, triggerTestId],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!root) return () => {};
      const observer = new MutationObserver(onChange);
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["aria-expanded"],
        subtree: true,
      });
      return () => observer.disconnect();
    },
    [root],
  );
  const expanded = useSyncExternalStore(
    subscribe,
    () => trigger()?.getAttribute("aria-expanded") === "true",
    () => false,
  );
  useBackDismiss(enabled && expanded, () => trigger()?.click());
  return expanded;
}
