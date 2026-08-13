import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const handoffPath = join(import.meta.dirname, ".drive", "serve-env.json");
const handoff = existsSync(handoffPath)
  ? JSON.parse(readFileSync(handoffPath, "utf8"))
  : null;
const baseURL = process.env.E2E_BASE_URL ?? handoff?.serverURL;

if (!baseURL) {
  throw new Error(
    "scratch needs a real E2E target: run `pnpm serve` first or set E2E_BASE_URL",
  );
}
const target = new URL(baseURL);
if (
  target.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(target.hostname)
) {
  throw new Error(`scratch refuses non-loopback target ${target.origin}`);
}

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
    baseURL,
    trace: "on",
    // 证据默认全留：scratch 的产物就是给人看的报告
    screenshot: "on",
    video: "on",
  },

  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],

  // 不自动起 Vite 或复用开发 server；默认读取 `pnpm serve` 的本轮 handoff。
  webServer: undefined,
});
