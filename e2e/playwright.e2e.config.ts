import { defineConfig, devices } from "@playwright/test";

// 正式 server 由 runner 绑定到专用 loopback 端口，并通过环境交给浏览器。
const appBaseUrl = process.env.E2E_BASE_URL;
if (!appBaseUrl) {
  throw new Error(
    "E2E_BASE_URL is required. Run the browser suite through `make e2e` or `pnpm smoke`.",
  );
}

// 只在手机视口跑的用例：溢出检查，加上标题带 @mobile 标签的手机壳用例。
// 桌面 project 反过来排除它们（桌面登录后落在 /overview，断言不同）。
const MOBILE_ONLY = /移动浏览器布局无水平溢出|@mobile/;

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: appBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
      grepInvert: MOBILE_ONLY,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      grep: MOBILE_ONLY,
    },
  ],
});
