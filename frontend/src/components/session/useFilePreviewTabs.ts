import { useCallback, useMemo, useState } from "react";

import type {
  FilePreviewSegment,
  FilePreviewTab,
} from "@agentre-hub/agentre-ui";

/**
 * 预览标签的状态（规格 2026-09-08 决策 7）。
 *
 * 共享面板只收 `tabs` / `activePath` / `segment` —— 「开几个、哪个是当前、临时
 * 还是常驻、markdown 看哪一档」是各宿主的布局问题，两端各答各的。这里是控制台
 * 这一份。
 *
 * 临时/常驻与桌面端同一套语义：单击开出来的是**临时**标签（标签条上以斜体标名），
 * 同一位置再开别的文件会把它顶掉；转常驻之后它才留下来。这条规矩的用处是「点着看
 * 一眼」不会在标签条上攒出一排再也用不到的文件。
 */
/** 宿主自己那份标签条目：共享包要的三格之外，还存 markdown 的视图档位。 */
interface ConsoleFilePreviewTab extends FilePreviewTab {
  /** markdown 的渲染/文本/双栏档；null 表示还没切过，由面板取它的默认档。 */
  segment: FilePreviewSegment | null;
}

export interface FilePreviewTabsState {
  tabs: FilePreviewTab[];
  /** 为 null 时预览栏整个收起（宿主据此判定）。 */
  activePath: string | null;
  /** 当前标签的 markdown 档位。 */
  activeSegment: FilePreviewSegment | null;
  /** 点开一个文件：已开着的只切过去，没开过的开一个临时标签。 */
  open: (path: string) => void;
  /** 双击标签：把临时标签转成常驻。**不**顺带固定 —— 那是另一件事。 */
  promote: (path: string) => void;
  /** 右键菜单的固定 / 取消固定，是个开关；固定顺带转常驻（桌面端同一条）。 */
  togglePin: (path: string) => void;
  /** 换 markdown 的视图档位，落在当前标签上。 */
  setSegment: (segment: FilePreviewSegment) => void;
  close: (path: string) => void;
  closeOthers: (path: string) => void;
  closeAll: () => void;
  /** 换会话：上一条会话开着的标签不能漏到下一条里。 */
  reset: () => void;
}

export function useFilePreviewTabs(): FilePreviewTabsState {
  const [tabs, setTabs] = useState<ConsoleFilePreviewTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const open = useCallback((path: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      // 临时标签最多一个：新的顶掉旧的（桌面端同一条规矩）。
      const kept = prev.filter((t) => !t.isPreview);
      return [
        ...kept,
        { path, isPreview: true, isPinned: false, segment: null },
      ];
    });
    setActivePath(path);
  }, []);

  const promote = useCallback((path: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.path === path ? { ...t, isPreview: false } : t)),
    );
  }, []);

  const togglePin = useCallback((path: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.path !== path
          ? t
          : t.isPinned
            ? // 取消固定不动位置、也不把它降回临时标签（桌面端 togglePreviewTabPin）。
              { ...t, isPinned: false }
            : { ...t, isPinned: true, isPreview: false },
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

  // 档位存在标签上而不是一格全局状态：切走再切回来要看到自己那一档（桌面端的
  // file-preview-tabs-store 同一条）。
  const setSegment = useCallback((segment: FilePreviewSegment) => {
    setActivePath((current) => {
      setTabs((prev) =>
        prev.map((t) => (t.path === current ? { ...t, segment } : t)),
      );
      return current;
    });
  }, []);

  const activeSegment =
    tabs.find((t) => t.path === activePath)?.segment ?? null;

  return useMemo(
    () => ({
      tabs,
      activePath,
      activeSegment,
      open,
      promote,
      togglePin,
      setSegment,
      close,
      closeOthers,
      closeAll,
      reset,
    }),
    [
      tabs,
      activePath,
      activeSegment,
      open,
      promote,
      togglePin,
      setSegment,
      close,
      closeOthers,
      closeAll,
      reset,
    ],
  );
}
