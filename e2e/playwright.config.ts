import { defineConfig, devices } from "@playwright/test";

import { APP_BASE_URL, FRONTEND_DEV_COMMAND } from "./fixtures/ports";

/**
 * 冒烟轨道配置（committed，跑在 CI 上）。
 *
 * 关键点是 testIgnore：**只靠 .gitignore 挡不住 scratch**。
 * gitignore 管的是「不提交」，而本地跑 `pnpm smoke` 时 scratch 目录就在磁盘上，
 * 不排除的话一次性验证脚本会混进冒烟结果里，让冒烟轨道慢慢烂掉。
 *
 * web/ 和 dual/ 是另外两条**按需**全链路轨道（`pnpm web` / `pnpm dual`，各自的
 * playwright.web.config.ts / playwright.dual.config.ts），环境变量由 run-e2e-web.mjs
 * 编排时注入。冒烟轨道必须一并排除它们——否则 CI 的 `make test-e2e` 会把它们扫进来，
 * 在第一个 requiredEnv（WEBE2E_SERVER_URL）上模块加载即失败（web/harness.ts）。
 */
export default defineConfig({
  testDir: ".",
  testIgnore: ["scratch/**", "web/**", "dual/**", "node_modules/**"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: APP_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  // 桌面端 + 移动端都要过——两者都是本项目声明支持的形态，
  // 只测桌面的话移动端布局回归没有任何信号。见 docs/design.md#responsive
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],

  // 前端 dev server 就够跑通 SPA 外壳（路由 / 主题 / i18n / 响应式）。
  // 需要真实后端的流程（设备流全链路）要 PG + Redis，属于 scratch 轨道，
  // 见 README.md 的「需要真后端时」。
  webServer: {
    command: FRONTEND_DEV_COMMAND,
    url: APP_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
