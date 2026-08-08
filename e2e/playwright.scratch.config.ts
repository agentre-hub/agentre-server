import { defineConfig, devices } from "@playwright/test";

import { APP_BASE_URL, FRONTEND_DEV_COMMAND } from "./fixtures/ports";

/**
 * scratch 轨道配置（本地一次性验证，整个 scratch/ 目录 gitignored）。
 *
 * 和冒烟轨道的差别只在 testDir 指向 scratch/：这样 CI 永远看不到它，
 * 而你在本地随时能跑。两份配置是一对——只改一份会让 scratch 要么进 CI、
 * 要么本地跑不起来。
 *
 * 用法见 README.md；报告规则见 docs/verification.md。
 */
export default defineConfig({
  testDir: "./scratch",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  // 一次性验证经常要等真实依赖，放宽超时
  timeout: 120_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: APP_BASE_URL,
    trace: "on",
    // 证据默认全留：scratch 的产物就是给人看的报告
    screenshot: "on",
    video: "on",
  },

  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],

  // scratch 默认不自动起服务：一次性验证往往要连你手动拉起来的那套
  // （真 PG + 真 Redis + 真 server）。需要自动起时在 scratch 用例里自己拉。
  webServer: process.env.E2E_SCRATCH_AUTOSTART
    ? {
        command: FRONTEND_DEV_COMMAND,
        url: APP_BASE_URL,
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});
