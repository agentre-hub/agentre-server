// Playwright config for the WEB FULL-CHAIN e2e (e2e/web/) — real browser +
// real agentre-server + real agentred. All orchestration lives in run-e2e-web.mjs
// (builds, server, seed, agentred, cleanup); this config only points testDir at
// ./web and reads the harness env. Never runs in CI; runs on demand.
import { defineConfig, devices } from "@playwright/test";

/**
 * 移动形态那条 spec 单独跑在移动视口上(设备描述符与冒烟轨道同一个 Pixel 7):
 * 列表分组、关注入口与下钻三联在两种视口下**是两种形态**(决策 10 / 12 / 16),
 * 桌面视口跑它等于什么都没验。其余用例仍是桌面档,不重复跑一遍。
 */
const MOBILE_SPEC = "**/session-mobile.spec.ts";

export default defineConfig({
  testDir: "./web",
  timeout: 120_000,
  // One browser against one shared server + one seeded account.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-web-report" }],
  ],
  use: {
    baseURL: process.env.WEBE2E_SERVER_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: MOBILE_SPEC,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: MOBILE_SPEC,
    },
  ],
});
