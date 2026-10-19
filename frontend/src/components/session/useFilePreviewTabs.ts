import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  previewKind,
  type FilePreviewSegment,
  type FilePreviewTab,
  type PreviewAnchor,
  type PreviewRevealTarget,
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
  /**
   * 这个标签要滚到哪一段：转录里点了一条带行号的链接才有，其余情况恒为 null。
   * 与桌面端同一条口径（file-preview-tabs-store 的 reveal）。
   */
  reveal: PreviewRevealTarget | null;
}

// 每记一次定位目标自增一次：同一条链接被重复点击时 path 与行号都不变，nonce 是
// 唯一会变的东西，也是「再滚一次」在数据上的全部表达。
let revealNonce = 0;

function mintReveal(
  anchor: PreviewAnchor | undefined,
): PreviewRevealTarget | null {
  if (!anchor) return null;
  revealNonce += 1;
  return { ...anchor, nonce: revealNonce };
}

export interface FilePreviewTabsState {
  tabs: FilePreviewTab[];
  /** 为 null 时预览栏整个收起（宿主据此判定）。 */
  activePath: string | null;
  /** 当前标签的 markdown 档位。 */
  activeSegment: FilePreviewSegment | null;
  /** 当前标签要滚到哪一段；为 null 表示这次不定位。 */
  activeReveal: PreviewRevealTarget | null;
  /**
   * 点开一个文件：已开着的只切过去，没开过的开一个临时标签。
   * `anchor` 是链接里写的行号（`script.ts:311-330`），不带就是不定位。
   */
  open: (path: string, anchor?: PreviewAnchor) => void;
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

  const open = useCallback((path: string, anchor?: PreviewAnchor) => {
    setTabs((prev) => {
      const reveal = mintReveal(anchor);
      const existing = prev.find((t) => t.path === path);
      if (existing) {
        // 已经开着：只切过去并重记定位目标（没带行号就清空，否则上一次跳过的位
        // 置会挂在标签上一直生效）。档位是它自己选的，不动。
        return prev.map((t) => (t.path === path ? { ...t, reveal } : t));
      }
      // 临时标签最多一个：新的顶掉旧的（桌面端同一条规矩）。
      const kept = prev.filter((t) => !t.isPreview);
      return [
        ...kept,
        {
          path,
          isPreview: true,
          isPinned: false,
          // markdown 的渲染档没有行的概念，带着行号开进去就定位不上：新开标签
          // 因此落在文本档（桌面端 initialSegment 同一条）。
          segment:
            anchor && previewKind(path) === "markdown"
              ? ("text" as FilePreviewSegment)
              : null,
          reveal,
        },
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

  const activeTab = tabs.find((t) => t.path === activePath);
  const activeSegment = activeTab?.segment ?? null;
  const activeReveal = activeTab?.reveal ?? null;

  return useMemo(
    () => ({
      tabs,
      activePath,
      activeSegment,
      activeReveal,
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
      activeReveal,
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

/**
 * 移动端整屏预览层在 history 里的那枚标记（规格 2026-09-21-server-mobile-gaps
 * 决策 2、4）：层开着时，当前这条 history 与会话同一地址、state 里多这一格。
 */
export const FILE_PREVIEW_LAYER_STATE_KEY = "agentreFilePreviewLayer";

function hasLayerMarker(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)[FILE_PREVIEW_LAYER_STATE_KEY] === true
  );
}

export interface FilePreviewLayerState {
  /** 层此刻开着：当前这条 history 带标记，且有当前标签。 */
  shown: boolean;
  /** 点开文件时调：层没开就压一条带标记的 history（同地址）。 */
  show: () => void;
  /** 层里的返回：退掉那一条，与系统返回同一条路。 */
  hide: () => void;
}

/**
 * 移动端的预览层开关。**不**另存一格开/关状态：开着 = 当前这条 history 带标记
 * 且有当前标签，于是返回按钮、系统返回（popstate）、前进都落在同一个事实上，
 * 标签本身一个不动（再点任意文件就回到这一层）。
 *
 *   - 重载后遗留的标记没有标签可显示，按关着算；此时再打开不另压一条 —— 当前这条
 *     已经带标记，退掉它就回到它下面那条不带标记的会话。
 *   - 关掉最后一个标签（当前标签变空）时层跟着关，并退掉它压的那一条，否则系统
 *     返回会先落在一条什么也不显示的标记上。
 *   - 桌面（enabled=false）从不碰 history。
 */
export function useFilePreviewLayer({
  enabled,
  activePath,
}: {
  enabled: boolean;
  activePath: string | null;
}): FilePreviewLayerState {
  const location = useLocation();
  const navigate = useNavigate();
  const marked = enabled && hasLayerMarker(location.state);
  const shown = marked && activePath !== null;

  // 退一条已经发出、还没落地（浏览器里 popstate 是异步的）：这期间再按返回不能
  // 再退一条，否则连点两下就离开了会话。落到新的一条上即解除。
  const popPendingRef = useRef(false);
  useEffect(() => {
    popPendingRef.current = false;
  }, [location.key]);

  const hide = useCallback(() => {
    if (!marked || popPendingRef.current) return;
    popPendingRef.current = true;
    void navigate(-1);
  }, [marked, navigate]);

  const show = useCallback(() => {
    if (!enabled || marked) return;
    void navigate(
      {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      {
        state: {
          ...(typeof location.state === "object" ? location.state : null),
          [FILE_PREVIEW_LAYER_STATE_KEY]: true,
        },
      },
    );
  }, [enabled, marked, navigate, location]);

  // 当前标签从有变无（关掉最后一个 / 全部关闭）且层开着：退掉那一条。只认这一次
  // 跳变 —— 重载后遗留的标记从来没有过标签，不会走到这里。
  const lastActiveRef = useRef(activePath);
  useEffect(() => {
    const had = lastActiveRef.current !== null;
    lastActiveRef.current = activePath;
    if (had && activePath === null) hide();
  }, [activePath, hide]);

  return { shown, show, hide };
}
