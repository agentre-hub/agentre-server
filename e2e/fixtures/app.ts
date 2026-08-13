import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { expect, test as base } from "@playwright/test";
import type { APIResponse, BrowserContext, Page } from "@playwright/test";

interface Handoff {
  serverURL: string;
  cookieName: string;
  sid: string;
  csrfToken: string;
  dsn: string;
  runID: string;
  userID: number;
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

interface DeviceToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  device_id: number;
}

interface OracleResult {
  run_id: string;
  user_id: number;
  flows: Array<{
    device_kind: string;
    authorized_user_id: number;
    approved_at: number;
    consumed_at: number;
    denied_at: number;
    expires_at: number;
  }>;
  devices: Array<{ id: number; kind: string; status: number }>;
  tokens: Array<{
    device_id: number;
    refresh_expires_at: number;
    last_used_at: number;
    revoked_at: number;
  }>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required; run through the E2E runner`);
  return value;
}

export function readHandoff(): Handoff {
  return JSON.parse(readFileSync(requiredEnv("E2E_HANDOFF_PATH"), "utf8"));
}

export async function assertIsAppUnderTest(page: Page) {
  await expect(page).toHaveTitle(/AgentRe Server/i);
  await expect(page.getByRole("button", { name: /Theme|主题/i })).toBeVisible();
}

export async function authenticate(context: BrowserContext) {
  const handoff = readHandoff();
  const url = new URL(handoff.serverURL);
  await context.addCookies([
    {
      name: handoff.cookieName,
      value: handoff.sid,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
}

function expectSuccessfulEnvelope<T>(response: APIResponse, body: unknown): T {
  expect(
    response.ok(),
    `HTTP ${response.status()}: ${JSON.stringify(body)}`,
  ).toBe(true);
  expect(body).toMatchObject({ code: 0 });
  return (body as { data: T }).data;
}

export async function authorizeDevice(
  page: Page,
): Promise<DeviceAuthorization> {
  const handoff = readHandoff();
  const response = await page.request.post("/v1/oauth/device/authorize", {
    headers: { "X-Forwarded-For": requiredEnv("E2E_RATE_LIMIT_IP") },
    data: {
      device_kind: "desktop",
      fingerprint: `webe2e-flow-${handoff.runID}`,
      platform: "linux",
      version: "e2e",
    },
  });
  return expectSuccessfulEnvelope(response, await response.json());
}

export async function exchangeDeviceCode(
  page: Page,
  deviceCode: string,
): Promise<{ response: APIResponse; body: unknown; token?: DeviceToken }> {
  const response = await page.request.post("/v1/oauth/device/token", {
    data: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    },
  });
  const body = await response.json();
  if (!response.ok()) return { response, body };
  return { response, body, token: expectSuccessfulEnvelope(response, body) };
}

export function readOracle(): OracleResult {
  const handoff = readHandoff();
  const tool = `${requiredEnv("E2E_RUNTIME_DIR")}/webe2e`;
  const stdout = execFileSync(
    tool,
    ["oracle", "--run-id", handoff.runID, "--user-id", String(handoff.userID)],
    {
      encoding: "utf8",
      env: { ...process.env, WEBE2E_DSN: handoff.dsn },
      timeout: 120_000,
    },
  );
  return JSON.parse(stdout);
}

export function horizontalOverflow(page: Page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

// 每个 Playwright project 都是独立 browser context；runner 同时为本轮提供独立
// MySQL 用户、Redis session 与 run ID。API 不做 route mock，所有请求直达正式 server。
export const test = base;
export { expect };
