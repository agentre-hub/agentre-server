import { useMemo, useSyncExternalStore } from "react";

/**
 * 软键盘弹着时可视区的高度与离布局视口顶边的距离；没弹着（或浏览器没有
 * visualViewport）时为 null。
 *
 * iOS 弹键盘不缩布局视口（`interactive-widget=resizes-content` 只有 Android Chrome
 * 认），只把可视区往上推：钉在顶边、高 100dvh 的外壳根整个被推上去，页头出了屏幕。
 * 外壳拿这里的值把自己对齐到键盘以上那一块（2026-11-20 用户截图）。
 *
 * Android 按 resizes-content 已经把布局视口一起缩了，两者差不出键盘高度，这里恒为
 * null，不重复处理。双指放大也会缩小可视区，scale 不是 1 时不当键盘。
 */
export type KeyboardViewport = { height: number; top: number };

/** 可视区至少比布局视口矮这么多才算键盘弹着：地址栏伸缩、输入法候选条都在这以内。 */
const KEYBOARD_MIN_PX = 120;

function layoutHeight(): number {
  // 布局视口高度：iOS 弹键盘时它不变；jsdom 里 clientHeight 为 0，退到 innerHeight。
  return document.documentElement.clientHeight || window.innerHeight;
}

/** 快照是字符串：useSyncExternalStore 要求没变时返回同一个值。 */
function snapshot(): string {
  const vv = window.visualViewport;
  if (!vv) return "";
  if (Math.abs(vv.scale - 1) > 0.01) return "";
  if (layoutHeight() - vv.height < KEYBOARD_MIN_PX) return "";
  return `${Math.round(vv.height)}:${Math.round(vv.offsetTop)}`;
}

function subscribe(onChange: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
  return () => {
    vv.removeEventListener("resize", onChange);
    vv.removeEventListener("scroll", onChange);
  };
}

export function useKeyboardViewport(): KeyboardViewport | null {
  const key = useSyncExternalStore(subscribe, snapshot, () => "");
  return useMemo(() => {
    if (!key) return null;
    const [height, top] = key.split(":").map(Number);
    return { height, top };
  }, [key]);
}
