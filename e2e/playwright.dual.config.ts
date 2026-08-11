// Playwright config for the DUAL-END e2e (e2e/dual/): the real Wails desktop app
// AND a real browser, both driving the SAME agentred.
//
// Everything stateful comes from `node run-e2e-web.mjs --dual` (server, seeded
// account, agentred, the desktop's data dir + seeded login). The only thing this
// config owns is the desktop app process: Playwright starts `wails dev` as a
// webServer, exactly like e2e/sync in the agentre repo, so readiness polling and
// teardown are its job and not the runner's.
//
// Reject a bare `playwright test --config` early: without the harness env the app
// would come up logged out against nothing, and every assertion would be
// meaningless rather than red for a real reason.
import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const name of [
  "WEBE2E_SERVER_URL",
  "WEBE2E_AGENTRE_DIR",
  "WEBE2E_DESKTOP_DATA_DIR",
  "WEBE2E_DESKTOP_DEVSERVER",
]) {
  if (!process.env[name]) {
    throw new Error(
      `playwright.dual.config.ts requires ${name}. Run \`pnpm dual\` ` +
        "(node run-e2e-web.mjs --dual), which starts agentre-server + agentred, " +
        "seeds a throwaway account and cleans it up afterwards.",
    );
  }
}

// The desktop bridge port is the runner's decision (it owns every port this run
// binds); specs read the same pair through dual/harness.ts.
const DEVSERVER = process.env.WEBE2E_DESKTOP_DEVSERVER as string;
const DESKTOP_URL = `http://${DEVSERVER}`;
const DESKTOP_LOG =
  process.env.WEBE2E_DESKTOP_LOG ?? join(tmpdir(), "webe2e-desktop.log");

export default defineConfig({
  testDir: "./dual",
  // One test drives two ends through several real turns over a relay; the desktop
  // app itself takes ~1 min to build and boot before the first assertion runs.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-dual-report" }],
  ],
  use: {
    // The browser end. The desktop end is opened by absolute URL (DESKTOP_URL).
    baseURL: process.env.WEBE2E_SERVER_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // -tags e2e compiles the fake runtime + the e2e seeding (including the paired
    // agentred this scenario needs). Output goes to a file, not Playwright's pipe:
    // `wails dev` orphans its vite child, and a piped stdout it keeps open would
    // stop teardown from ever finishing.
    command: `wails dev -tags e2e -devserver ${DEVSERVER} > "${DESKTOP_LOG}" 2>&1`,
    cwd: process.env.WEBE2E_AGENTRE_DIR,
    url: DESKTOP_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      AGENTRE_DATA_DIR: process.env.WEBE2E_DESKTOP_DATA_DIR as string,
      AGENTRE_ENV: "test",
      // Bind the local gateway to a free port: the fixed default 52401 is not
      // data-dir scoped, so a real Agentre running on this machine holds it.
      AGENTRE_PROXY_PORT: "0",
      AGENTRE_E2E_KEYCHAIN_DIR: process.env
        .WEBE2E_DESKTOP_KEYCHAIN_DIR as string,
      // The seeded login (e2e/fakes/login.go).
      AGENTRE_E2E_SERVER_URL: process.env.AGENTRE_E2E_SERVER_URL as string,
      AGENTRE_E2E_SERVER_USER_ID: process.env
        .AGENTRE_E2E_SERVER_USER_ID as string,
      AGENTRE_E2E_DEVICE_ID: process.env.AGENTRE_E2E_DEVICE_ID as string,
      AGENTRE_E2E_DEVICE_FINGERPRINT: process.env
        .AGENTRE_E2E_DEVICE_FINGERPRINT as string,
      AGENTRE_E2E_REFRESH_TOKEN: process.env
        .AGENTRE_E2E_REFRESH_TOKEN as string,
      // The agentred this desktop must join (e2e/fakes/remote.go).
      AGENTRE_E2E_AGENTRED_FINGERPRINT: process.env
        .AGENTRE_E2E_AGENTRED_FINGERPRINT as string,
      AGENTRE_E2E_AGENTRED_URL: process.env.AGENTRE_E2E_AGENTRED_URL as string,
    },
  },
});
