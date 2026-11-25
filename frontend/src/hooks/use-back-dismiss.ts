import { useCallback, useEffect, useRef, useState } from "react";
import {
  useLocation,
  useNavigate,
  useNavigationType,
  type Location,
} from "react-router-dom";

import { useIsMobile } from "@/components/use-is-mobile";

const BACK_DISMISS_STATE_KEY = "agentreBackDismiss";

/**
 * 某一层从界面关掉、正在退它的记号：浏览器的 history.go 是异步的，退完之前地址还停在
 * 那条记号上。记着发起时那一条的 key；同一次提交里另一层要开（信息层 → 删除确认、
 * ••• 菜单 → 改名框），得等这一退落地再压，否则新压的记号会被这一退带走、多留一格。
 */
let pendingPop: { key: string } | null = null;

interface Entry {
  level: number;
  landed: boolean;
  pathname: string;
  // 另一层的退记号还没落地：等地址换了再压。
  deferred?: boolean;
  // 下面那一层关掉、把它的记号让给这一层：退到那一格（层数 = adopt）后认作自己的。
  adopt?: number;
  // 页面 replace 了地址、正在把多出来的那一格收回去：记着要落到的地址。
  collapse?: { to: Location; key: string };
}

/**
 * 眼下各层的记号。反过来的次序也会发生：新的一层先压（Radix 菜单项的 onSelect 先单独
 * 提交），菜单在下一次提交才关——这时菜单的记号已被压在下面，直接退会把新的一层退掉。
 */
const liveEntries = new Set<{ current: Entry | null }>();

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
 *     不是被返回键关的，留着；历史收回成「新地址 + 记号」两格，不多一条；
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
  const entryRef = useRef<Entry | null>(null);
  useEffect(() => {
    liveEntries.add(entryRef);
    return () => {
      liveEntries.delete(entryRef);
    };
  }, []);

  // 在当前地址上压一条带记号的历史，并记下这一层。
  const push = useCallback(
    (at?: Location) => {
      const here = at ?? locationRef.current;
      const level = backDismissLayerOf(here.state) + 1;
      entryRef.current = { level, landed: false, pathname: here.pathname };
      void navigate(
        { pathname: here.pathname, search: here.search, hash: here.hash },
        {
          state: {
            ...(typeof here.state === "object" ? here.state : null),
            [BACK_DISMISS_STATE_KEY]: level,
          },
        },
      );
    },
    [navigate],
  );

  const active = open && enabled;
  useEffect(() => {
    if (active) {
      if (entryRef.current) return;
      if (pendingPop?.key === locationRef.current.key) {
        entryRef.current = {
          level: 0,
          landed: false,
          pathname: locationRef.current.pathname,
          deferred: true,
        };
      } else push();
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
      // 上面已经压了别的层：退一格后那一层接过这条记号，历史与只开它时一样长。
      const above = [...liveEntries]
        .map((r) => r.current)
        .find((e) => e !== null && !e.deferred && e.level > entry.level);
      if (above) above.adopt = entry.level;
      else pendingPop = { key: locationRef.current.key };
      void navigate(-1);
    }
  }, [active, navigate, push]);

  // 记号落地后又掉下去：
  //   - 被返回键退掉 / 路由换走了：把浮层收起来；
  //   - 同一页上被 replace 换掉（换筛选、换范围）：浮层留着。replace 换掉的是记号那
  //     一格，它下面还垫着换之前的那一格，直接重压会多出一条；所以先退回下面那一格，
  //     把新地址 replace 上去，再压回记号——历史与没开浮层时一样长。
  const layer = backDismissLayerOf(location.state);
  useEffect(() => {
    if (pendingPop && pendingPop.key !== location.key) pendingPop = null;
    const entry = entryRef.current;
    if (!entry) return;
    if (entry.deferred) {
      if (!pendingPop) push(location);
      return;
    }
    if (entry.adopt !== undefined) {
      if (layer === entry.adopt) {
        entry.level = entry.adopt;
        entry.adopt = undefined;
        entry.landed = true;
      }
      return;
    }
    if (entry.collapse) {
      if (layer === 0 && location.key !== entry.collapse.key) {
        const to = entry.collapse.to;
        entry.collapse = undefined;
        void navigate(
          { pathname: to.pathname, search: to.search, hash: to.hash },
          { replace: true, state: to.state },
        );
        push(to);
      }
      return;
    }
    if (layer >= entry.level) {
      entry.landed = true;
    } else if (entry.landed) {
      if (
        navigationType === "REPLACE" &&
        location.pathname === entry.pathname
      ) {
        entry.landed = false;
        entry.collapse = { to: location, key: location.key };
        void navigate(-1);
      } else {
        entryRef.current = null;
        closeRef.current();
      }
    }
  }, [layer, location, navigationType, navigate, push]);
}

/**
 * 自己管开关的浮层（••• 菜单、下拉选择）在手机上接返回键：给 Radix 根的
 * `open` / `onOpenChange` 直接展开用。
 */
export function useBackDismissOpen(): {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  useBackDismiss(open, () => setOpen(false));
  return { open, onOpenChange: setOpen };
}
