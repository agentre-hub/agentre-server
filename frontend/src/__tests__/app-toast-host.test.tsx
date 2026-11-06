import { render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it } from "vitest";

import App from "@/App";
import { MOBILE_TAB_BAR_CLEARANCE } from "@/lib/mobileLayout";
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
 * 手机上没有底栏了（规格 2026-11-05：底部 tab 换成左抽屉），toast 不必再让开那
 * 74px —— 仍旧让开的话，它会悬在屏幕中段、离底边一大截。贴底只留呼吸空间与安全区。
 */
it("移动端:toast 只让开安全区,不再为已不存在的底栏让位", async () => {
  window.history.replaceState({}, "", "/terms");
  render(<App />, { wrapper: ThemeProvider });
  toast.success("saved");
  await screen.findByText("saved");

  const host = document.querySelector("[data-sonner-toaster]");
  expect(host).toBeTruthy();
  // sonner 把 mobileOffset 落成 --mobile-offset-bottom 这个自定义属性。
  const offset = (host as HTMLElement).style.getPropertyValue(
    "--mobile-offset-bottom",
  );
  expect(offset).not.toBe(MOBILE_TAB_BAR_CLEARANCE);
  expect(offset).not.toContain("74px");
  expect(offset).toContain("safe-area-inset-bottom");
});
