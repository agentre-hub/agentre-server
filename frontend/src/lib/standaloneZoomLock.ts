/**
 * 主屏幕 App（display-mode: standalone）里禁止缩放，交互上更像原生 App。
 *
 * 只在独立窗口里生效：index.html 的 viewport 保持可缩放，Safari 标签页与桌面浏览器
 * 不受影响（见 docs/design.md 的 PWA 小节）。三层一起上，因为任何一层单独都不够：
 *
 * - viewport 追加 `maximum-scale=1, user-scalable=no`：Android / Chromium 认它；
 *   iOS 也会据此不再在聚焦小字号输入框时放大页面。
 * - 拦 WebKit 专有的 `gesturestart` / `gesturechange`：iOS 从 10 起无视
 *   user-scalable=no 的双指缩放，只有取消这两个事件才拦得住。
 * - 根元素 `touch-action: manipulation`：关掉双击放大，平移与点按照常。
 *
 * 返回撤销函数（测试与将来热更新用）；viewport 的改写不撤销，进程内只做一次也无害。
 */
const ZOOM_LOCK_KEYS = ["maximum-scale=1", "user-scalable=no"] as const;

function isStandalone(win: Window): boolean {
  const legacy = (win.navigator as Navigator & { standalone?: boolean })
    .standalone;
  return (
    win.matchMedia("(display-mode: standalone)").matches || legacy === true
  );
}

function preventPinch(event: Event): void {
  event.preventDefault();
}

export function lockZoomWhenStandalone(win: Window = window): () => void {
  if (!isStandalone(win)) return () => {};

  const doc = win.document;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) {
    const content = meta.getAttribute("content") ?? "";
    const missing = ZOOM_LOCK_KEYS.filter((key) => !content.includes(key));
    if (missing.length > 0) {
      meta.setAttribute(
        "content",
        [content, ...missing].filter(Boolean).join(", "),
      );
    }
  }

  doc.documentElement.style.touchAction = "manipulation";
  doc.addEventListener("gesturestart", preventPinch, { passive: false });
  doc.addEventListener("gesturechange", preventPinch, { passive: false });

  return () => {
    doc.removeEventListener("gesturestart", preventPinch);
    doc.removeEventListener("gesturechange", preventPinch);
    doc.documentElement.style.touchAction = "";
  };
}
