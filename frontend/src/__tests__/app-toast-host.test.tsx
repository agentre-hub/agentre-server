import { render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it } from "vitest";

import App from "@/App";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

afterEach(() => {
  toast.dismiss();
  window.history.replaceState({}, "", "/");
});

it("Given a shared UI action emits feedback, When App is mounted, Then the user sees the toast", async () => {
  window.history.replaceState({}, "", "/terms");
  render(<App />, { wrapper: ThemeProvider });

  toast.success("AI output copied");

  expect(await screen.findByText("AI output copied")).toBeTruthy();
});

/**
 * 手机上 toast 落在**顶部**（2026-11-19 手机形态排查）。
 *
 * 贴底时它恰好盖在输入框上：复制成功 / 发送失败这几条要挂 5–7 秒，这期间输入框和
 * 发送 / 停止键都点不到，而那正是这一屏的主操作。顶部让开状态栏那条安全区。
 */
const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function mockMobileViewport() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

it("移动端:toast 落在顶部、让开状态栏安全区,不压在输入框上", async () => {
  mockMobileViewport();
  window.history.replaceState({}, "", "/terms");
  render(<App />, { wrapper: ThemeProvider });
  toast.success("saved");
  await screen.findByText("saved");

  const list = document.querySelector("[data-sonner-toaster]");
  expect(list).toBeTruthy();
  expect(list?.getAttribute("data-y-position")).toBe("top");
  // sonner 把 mobileOffset 落成 --mobile-offset-top 这个自定义属性。
  expect(
    (list as HTMLElement).style.getPropertyValue("--mobile-offset-top"),
  ).toContain("safe-area-inset-top");
});

it("桌面:toast 仍在右下角", async () => {
  window.history.replaceState({}, "", "/terms");
  render(<App />, { wrapper: ThemeProvider });
  toast.success("desk");
  await screen.findByText("desk");

  const list = document.querySelector("[data-sonner-toaster]");
  expect(list?.getAttribute("data-y-position")).toBe("bottom");
  expect(list?.getAttribute("data-x-position")).toBe("right");
});
