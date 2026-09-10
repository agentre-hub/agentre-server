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
 * toast 不能压住移动端底栏。
 *
 * sonner 在窄视口下会把 `bottom-*` 拍成贴底全宽，而 `MobileTabBar` 是 74px 的
 * 正常流元素、就贴在同一条边上。Chat 页那颗 FAB 也在 `bottom-24 right-4`。
 * 这一条此前只是隐患；把决策失败、保存失败这些回执改成 toast 之后，它变成了
 * 「一出错就把导航盖住」——而出错时用户最需要的正是换个地方看看。
 */
it("移动端:toast 让开底栏那 74px,不盖住导航", async () => {
  window.history.replaceState({}, "", "/terms");
  render(<App />, { wrapper: ThemeProvider });
  toast.success("saved");
  await screen.findByText("saved");

  const host = document.querySelector("[data-sonner-toaster]");
  expect(host).toBeTruthy();
  // sonner 把 mobileOffset 落成 --mobile-offset-bottom 这个自定义属性。
  expect(
    (host as HTMLElement).style.getPropertyValue("--mobile-offset-bottom"),
  ).toBe("90px");
});
