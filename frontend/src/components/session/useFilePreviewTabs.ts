import { useCallback, useMemo, useState } from "react";

import type { FilePreviewTab } from "@agentre-hub/agentre-ui";

/**
 * 预览标签的状态（规格 2026-09-08 决策 7）。
 *
 * 共享面板只收 `tabs` 与 `activePath` —— 「开几个、哪个是当前、临时还是常驻」
 * 是各宿主的布局问题，两端各答各的。这里是控制台这一份。
 *
 * 临时/常驻与桌面端同一套语义：单击开出来的是**临时**标签（标签条上以斜体标名），
 * 同一位置再开别的文件会把它顶掉；钉住之后它才留下来。这条规矩的用处是「点着看
 * 一眼」不会在标签条上攒出一排再也用不到的文件。
 */
export interface FilePreviewTabsState {
  tabs: FilePreviewTab[];
  /** 为 null 时预览栏整个收起（宿主据此判定）。 */
  activePath: string | null;
  /** 点开一个文件：已开着的只切过去，没开过的开一个临时标签。 */
  open: (path: string) => void;
  /** 把临时标签钉成常驻。 */
  pin: (path: string) => void;
  close: (path: string) => void;
  closeOthers: (path: string) => void;
  closeAll: () => void;
  /** 换会话：上一条会话开着的标签不能漏到下一条里。 */
  reset: () => void;
}

export function useFilePreviewTabs(): FilePreviewTabsState {
  const [tabs, setTabs] = useState<FilePreviewTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const open = useCallback((path: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      // 临时标签最多一个：新的顶掉旧的（桌面端同一条规矩）。
      const kept = prev.filter((t) => !t.isPreview);
      return [...kept, { path, isPreview: true, isPinned: false }];
    });
    setActivePath(path);
  }, []);

  const pin = useCallback((path: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.path === path ? { ...t, isPreview: false, isPinned: true } : t,
      ),
    );
  }, []);

  const close = useCallback((path: string) => {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.path === path);
      if (index < 0) return prev;
      const next = prev.filter((t) => t.path !== path);
      setActivePath((current) => {
        if (current !== path) return current;
        // 关掉当前那个时，当前落到它左边那个；没有左边就取右边；都没有就收起。
        const fallback = next[index - 1] ?? next[index] ?? null;
        return fallback ? fallback.path : null;
      });
      return next;
    });
  }, []);

  const closeOthers = useCallback((path: string) => {
    setTabs((prev) => prev.filter((t) => t.path === path));
    setActivePath(path);
  }, []);

  const closeAll = useCallback(() => {
    setTabs([]);
    setActivePath(null);
  }, []);

  const reset = closeAll;

  return useMemo(
    () => ({
      tabs,
      activePath,
      open,
      pin,
      close,
      closeOthers,
      closeAll,
      reset,
    }),
    [tabs, activePath, open, pin, close, closeOthers, closeAll, reset],
  );
}
