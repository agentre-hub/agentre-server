// Playwright config for the WEB FULL-CHAIN e2e (e2e/web/) — real browser +
// real agentre-server + real agentred. All orchestration lives in run-e2e-web.mjs
// (builds, server, seed, agentred, cleanup); this config only points testDir at
// ./web and reads the harness env. Never runs in CI; runs on demand.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./web",
  timeout: 120_000,
  // One browser against one shared server + one seeded account.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-web-report" }]],
  use: {
    baseURL: process.env.WEBE2E_SERVER_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
