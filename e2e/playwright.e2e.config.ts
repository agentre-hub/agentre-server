import { defineConfig, devices } from "@playwright/test";

import { APP_BASE_URL } from "./fixtures/ports";

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 120_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: APP_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
      grepInvert: /移动浏览器布局无水平溢出/,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      grep: /移动浏览器布局无水平溢出/,
    },
  ],
});
