import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

import { useIsMobile } from "@/components/use-is-mobile";

const BACK_DISMISS_STATE_KEY = "agentreBackDismiss";

/** 当前这一条历史上记着的浮层层数；没有记号按 0 算。 */
export function backDismissLayerOf(state: unknown): number {
  if (typeof state !== "object" || state === null) return 0;
  const v = (state as Record<string, unknown>)[BACK_DISMISS_STATE_KEY];
  return typeof v === "number" ? v : 0;
}

/**
 * 手机上的浮层进历史（规格 2026-11-25 D1「系统返回 = 关掉最上层的浮层」）。
 *
 * 浮层开着时在历史里压一条同地址的记号（层数 = 下面已有的层数 + 1）：
 *   - 系统返回退掉这一条，页面不动，这里调 `close()` 把浮层收起来；
 *   - 从界面关掉浮层（✕、取消、选中、点遮罩）则把这一条退掉，历史不会越点越长；
 *   - 嵌套的浮层各压一条，层数大的在上面，返回自然由内向外逐层关；
 *   - 浮层开着时路由已经换走（点了抽屉里的链接）：新地址上没有记号，浮层跟着收起，
 *     不再多退一格；
 *   - 浮层开着时页面自己 replace 了地址（换筛选、换范围；记号随之被换掉）：浮层
 *     不是被返回键关的，留着，并在新地址上重新压一条记号；
 *   - 桌面宽度从不碰 history。
 *
 * 与 useFilePreviewLayer 同一路子（location.state 里的记号 + navigate(-1)）；
 * 记号用 ref 跟着，所以 StrictMode 下挂载时的「装、卸、再装」不会压出两条。
 */
export function useBackDismiss(open: boolean, close: () => void): void {
  const enabled = useIsMobile();
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();

  const locationRef = useRef(location);
  const closeRef = useRef(close);
  // 排在其它 effect 之前：它们读到的永远是本次渲染的 location 与 close。
  useEffect(() => {
    locationRef.current = location;
    closeRef.current = close;
  });
  // 这一层的记号：level 是压进去的层数，landed 是已经在 location 上看到它落地。
  const entryRef = useRef<{ level: number; landed: boolean } | null>(null);

  // 在当前地址上压一条带记号的历史，并记下这一层。
  const push = useCallback(() => {
    const here = locationRef.current;
    const level = backDismissLayerOf(here.state) + 1;
    entryRef.current = { level, landed: false };
    void navigate(
      { pathname: here.pathname, search: here.search, hash: here.hash },
      {
        state: {
          ...(typeof here.state === "object" ? here.state : null),
          [BACK_DISMISS_STATE_KEY]: level,
        },
      },
    );
  }, [navigate]);

  const active = open && enabled;
  useEffect(() => {
    if (active) {
      if (!entryRef.current) push();
      return;
    }
    const entry = entryRef.current;
    if (!entry) return;
    entryRef.current = null;
    // 只在眼下正站在这条记号上时才退；路由已换走就留给历史。
    if (
      entry.landed &&
      backDismissLayerOf(locationRef.current.state) >= entry.level
    ) {
      void navigate(-1);
    }
  }, [active, navigate, push]);

  // 记号落地后又掉下去：被返回键退掉了就把浮层收起来；被 replace 换掉了就重压一条。
  const layer = backDismissLayerOf(location.state);
  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    if (layer >= entry.level) {
      entry.landed = true;
    } else if (entry.landed) {
      if (navigationType === "REPLACE") push();
      else {
        entryRef.current = null;
        closeRef.current();
      }
    }
  }, [layer, location.key, navigationType, push]);
}
