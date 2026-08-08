import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * 后端统一响应信封。前端 src/lib/api.ts 会检查 `code !== 0` 再取 `data`，
 * 所以 mock 必须裹上信封——直接返回裸对象会让 api() 抛 ApiError，
 * 表现成「mock 了成功却走进失败分支」，很难看出是 mock 的问题。
 */
function envelope(data: unknown) {
  return JSON.stringify({ code: 0, msg: "", data });
}

/**
 * 断言当前页面确实是「本次要测的这个应用」，而不是碰巧占着同一个端口的别的进程。
 *
 * 没有这一步的话，端口被别的服务占用时测试可能一路绿灯——它测的是别人的 200。
 * 注意断言要落在 **React 真的挂载出来的东西** 上：只查 <title> 和 #root
 * 是不够的，两者都来自 index.html，React 整棵树崩掉时它们照样在。
 */
export async function assertIsAppUnderTest(page: Page) {
  await expect(page).toHaveTitle(/AgentRe Server/i);
  // AppControls 是所有路由共用的外壳，渲染出来才说明 React 树活着
  await expect(page.getByRole("button", { name: /Theme|主题/i })).toBeVisible();
}

/** 未登录：/v1/auth/me 返回 401。SPA 应当据此跳到 /login。 */
export async function mockUnauthenticated(page: Page) {
  await page.route("**/v1/auth/me", (route: Route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ code: 401, msg: "unauthorized", data: null }),
    }),
  );
}

/** 已登录：/v1/auth/me 返回一个用户。 */
export async function mockAuthenticated(
  page: Page,
  overrides: Record<string, unknown> = {},
) {
  await page.route("**/v1/auth/me", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        user_id: 1,
        email: "e2e@example.com",
        display_name: "E2E User",
        avatar_url: "",
        github_login: "e2e-user",
        csrf_token: "e2e-csrf-token",
        ...overrides,
      }),
    }),
  );
}

/** 设备流 pending 信息。 */
export async function mockDevicePending(
  page: Page,
  overrides: Record<string, unknown> = {},
) {
  await page.route("**/v1/oauth/device/pending**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: envelope({
        device_kind: "desktop",
        platform: "darwin",
        version: "0.1.0",
        capabilities: { chat: true, terminal: false },
        expires_in: 600,
        ...overrides,
      }),
    }),
  );
}

// 不要加自定义 fixture 去清 localStorage：Playwright 每个用例都是独立 browser
// context，localStorage 本来就是空的。而用 addInitScript 清理会在**每次导航**时
// 重跑，page.reload() 会连用例刚写进去的偏好一起抹掉，把「持久化正常」测成失败。
export { expect, test };
