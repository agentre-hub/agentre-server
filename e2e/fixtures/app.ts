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

interface SyncItem {
  kind: string;
  sync_id: string;
  payload: Record<string, unknown>;
  version: number;
  updated_at: number;
  origin_fingerprint: string;
  deleted_at: number;
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
  sync_objects: Array<{
    sync_id: string;
    kind: string;
    version: number;
    deleted_at: number;
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

async function addSessionCookie(
  context: BrowserContext,
  sid: string,
  hostname: string,
) {
  const handoff = readHandoff();
  await context.addCookies([
    {
      name: handoff.cookieName,
      value: sid,
      domain: hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
}

export async function authenticate(context: BrowserContext) {
  const handoff = readHandoff();
  const url = new URL(handoff.serverURL);
  await addSessionCookie(context, handoff.sid, url.hostname);
}

/**
 * 通行密钥用例专用：种子会话搬到 `localhost` 的 host-only cookie 上。浏览器在
 * IP 字面量 origin 上拒绝 WebAuthn（rp_id 必须是有效域名），configs/config.e2e
 * 的 webauthn.rp_id 因此是 "localhost"、origins 两种拼法都列了——其余用例走共享
 * 的 127.0.0.1 baseURL 没事，是因为它们从不触发 navigator.credentials.*。
 * 与 passkeyOrigin() 配对使用。
 */
export async function authenticateForPasskeys(context: BrowserContext) {
  const handoff = readHandoff();
  await addSessionCookie(context, handoff.sid, "localhost");
}

/** 与 authenticateForPasskeys 配对：WebAuthn 场景要用的同源 origin。 */
export function passkeyOrigin(): string {
  const handoff = readHandoff();
  const url = new URL(handoff.serverURL);
  return `http://localhost:${url.port}`;
}

/**
 * 打开 Chromium 的虚拟认证器（经 CDP `WebAuthn.enable` +
 * `WebAuthn.addVirtualAuthenticator` 注入），只有 Chromium 支持这条 CDP 域。
 * 可发现凭证 + 用户验证都置真，让 navigator.credentials.create()/get() 不经过
 * 任何系统弹窗自动完成——真实认证器（Touch ID、安全钥匙、跨设备扫码）没有这条路，
 * 无法自动化，留给收尾时的一次真机手动核对（docs/specs/2026-08-18-account-security.md
 * 「Testing decisions」）。
 */
export async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
) {
  const client = await context.newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** 用户菜单里的「账号与安全」：与桌面/移动共用同一个触发器（UserMenu.tsx）。 */
export async function openAccountFromUserMenu(page: Page) {
  await page.getByRole("button", { name: /账号菜单|Account menu/i }).click();
  await page
    .getByRole("menuitem", { name: /账号与安全|Account & security/i })
    .click();
  await page.waitForURL(/\/account$/);
}

/** 用户菜单里的「登出」：无论端点成败都会落地登录页（UserMenu.tsx 注释）。 */
export async function signOutViaUserMenu(page: Page) {
  await page.getByRole("button", { name: /账号菜单|Account menu/i }).click();
  await page.getByRole("menuitem", { name: /^登出$|^Sign out$/i }).click();
  await page.waitForURL(/\/login/);
}

function expectSuccessfulEnvelope<T>(response: APIResponse, body: unknown): T {
  expect(
    response.ok(),
    `HTTP ${response.status()}: ${JSON.stringify(body)}`,
  ).toBe(true);
  expect(body).toMatchObject({ code: 0 });
  return (body as { data: T }).data;
}

/**
 * 用种子会话把这个账号名下的**其它**会话全部撤掉（`POST
 * /v1/auth/sessions/revoke-others`，写方法要出示种子会话的 CSRF token）。
 *
 * 一个 project 里所有用例共用同一个种子账号，通行密钥那条用例登录时会在同一账号
 * 下真的再建一个会话。哪条用例要断言「名下只剩当前这一个」，前置条件就得由它
 * 自己建立——靠别的用例收尾腾干净是隐式的用例间依赖：那条用例一旦在收尾前失败，
 * 断言会以「找不到文案」的面目失败，指向的却是另一个用例的错。
 */
export async function revokeOtherSessions(page: Page) {
  const handoff = readHandoff();
  const response = await page.request.post("/v1/auth/sessions/revoke-others", {
    headers: { "X-CSRF-Token": handoff.csrfToken },
  });
  expectSuccessfulEnvelope(response, await response.json());
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

export async function refreshDeviceToken(
  page: Page,
  refreshToken: string,
): Promise<{ response: APIResponse; body: unknown; token?: DeviceToken }> {
  const response = await page.request.post("/v1/oauth/token/refresh", {
    data: { refresh_token: refreshToken },
  });
  const body = await response.json();
  if (!response.ok()) return { response, body };
  return { response, body, token: expectSuccessfulEnvelope(response, body) };
}

export async function requestWithDeviceToken(
  page: Page,
  path: string,
  accessToken: string,
) {
  return page.request.get(path, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function pushAndPullSyncObject(
  page: Page,
  accessToken: string,
): Promise<{ syncID: string; version: number }> {
  const handoff = readHandoff();
  const syncID = `webe2e-project-${handoff.runID}`;
  const payload = { name: `webe2e project ${handoff.runID}` };
  const headers = { Authorization: `Bearer ${accessToken}` };
  const pushResponse = await page.request.post("/v1/sync/push", {
    headers,
    data: {
      items: [
        {
          kind: "project",
          sync_id: syncID,
          base_version: 0,
          updated_at: Date.now(),
          payload,
        },
      ],
    },
  });
  const push = expectSuccessfulEnvelope<{
    results: Array<{
      sync_id: string;
      kind: string;
      version: number;
      status: string;
    }>;
  }>(pushResponse, await pushResponse.json());
  expect(push.results).toEqual([
    expect.objectContaining({
      sync_id: syncID,
      kind: "project",
      version: expect.any(Number),
      status: "accepted",
    }),
  ]);

  const version = push.results[0].version;
  const pullResponse = await page.request.get(
    "/v1/sync/pull?cursor=0&limit=100",
    {
      headers,
    },
  );
  const pull = expectSuccessfulEnvelope<{
    items: SyncItem[];
    next_cursor: number;
    has_more: boolean;
  }>(pullResponse, await pullResponse.json());
  expect(pull.items).toContainEqual(
    expect.objectContaining({
      kind: "project",
      sync_id: syncID,
      payload,
      version,
      deleted_at: 0,
    }),
  );
  expect(pull.next_cursor).toBeGreaterThanOrEqual(version);
  return { syncID, version };
}

export async function revokeDeviceFromBrowserSession(
  page: Page,
  deviceID: number,
) {
  const handoff = readHandoff();
  const response = await page.request.post("/v1/oauth/token/revoke", {
    headers: { "X-CSRF-Token": handoff.csrfToken },
    data: { device_id: deviceID },
  });
  expectSuccessfulEnvelope(response, await response.json());
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
