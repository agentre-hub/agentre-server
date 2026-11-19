import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lockZoomWhenStandalone } from "@/lib/standaloneZoomLock";

/**
 * 主屏幕 App（display-mode: standalone）里禁止缩放，更像原生 App（2026-11-19 用户要求）。
 * Safari 标签页里照常能缩放：index.html 的 viewport 不写死，只在独立窗口里运行时改写。
 *
 * iOS 从 10 起不认 user-scalable=no 的双指缩放，所以另外拦 WebKit 专有的 gesturestart /
 * gesturechange；双击放大由 touch-action: manipulation 关掉。真机效果只能上手机验。
 */
const BASE_VIEWPORT =
  "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content";

function fakeWindow(standalone: { media?: boolean; navigator?: boolean }) {
  return {
    matchMedia: (query: string) => ({
      matches: query === "(display-mode: standalone)" && !!standalone.media,
    }),
    navigator: { standalone: standalone.navigator },
    document,
  } as unknown as Window;
}

function viewport(): string {
  return (
    document
      .querySelector<HTMLMetaElement>('meta[name="viewport"]')
      ?.getAttribute("content") ?? ""
  );
}

function pinch(type: "gesturestart" | "gesturechange"): Event {
  const event = new Event(type, { cancelable: true });
  document.dispatchEvent(event);
  return event;
}

let release: (() => void) | undefined;

beforeEach(() => {
  document.head.innerHTML = `<meta name="viewport" content="${BASE_VIEWPORT}">`;
  document.documentElement.style.touchAction = "";
});
afterEach(() => {
  release?.();
  release = undefined;
  document.head.innerHTML = "";
  document.documentElement.style.touchAction = "";
});

describe("lockZoomWhenStandalone", () => {
  it("Given the Home Screen app (display-mode: standalone) When locked Then the viewport forbids zoom, pinch gestures are cancelled and double-tap zoom is off", () => {
    release = lockZoomWhenStandalone(fakeWindow({ media: true }));

    expect(viewport()).toContain("maximum-scale=1");
    expect(viewport()).toContain("user-scalable=no");
    expect(viewport()).toContain("viewport-fit=cover");
    expect(pinch("gesturestart").defaultPrevented).toBe(true);
    expect(pinch("gesturechange").defaultPrevented).toBe(true);
    expect(document.documentElement.style.touchAction).toBe("manipulation");
  });

  it("Given older iOS that only exposes navigator.standalone When locked Then it is treated as the Home Screen app too", () => {
    release = lockZoomWhenStandalone(fakeWindow({ navigator: true }));

    expect(viewport()).toContain("user-scalable=no");
  });

  it("Given a normal Safari tab When locked Then nothing changes and pinch-zoom still works", () => {
    release = lockZoomWhenStandalone(fakeWindow({}));

    expect(viewport()).toBe(BASE_VIEWPORT);
    expect(pinch("gesturestart").defaultPrevented).toBe(false);
    expect(document.documentElement.style.touchAction).toBe("");
  });

  it("Given it runs twice When locked Then the viewport keys are not duplicated", () => {
    lockZoomWhenStandalone(fakeWindow({ media: true }))();
    release = lockZoomWhenStandalone(fakeWindow({ media: true }));

    expect(viewport().match(/user-scalable=no/g)).toHaveLength(1);
    expect(viewport().match(/maximum-scale=1/g)).toHaveLength(1);
  });
});
