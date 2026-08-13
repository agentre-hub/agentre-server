import {
  assertIsAppUnderTest,
  authenticate,
  authorizeDevice,
  exchangeDeviceCode,
  expect,
  horizontalOverflow,
  readHandoff,
  readOracle,
  test,
} from "./fixtures/app";

test("正式 server 健康且同时连接真实 MySQL 与 Redis", async ({ request }) => {
  const response = await request.get("/v1/healthz");
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body).toMatchObject({
    code: 0,
    data: { status: "ok", db_ping: true, redis: true },
  });
});

test("未登录鉴权走真实 401 envelope 并保留目标跳到登录页", async ({ page }) => {
  const me = await page.request.get("/v1/auth/me");
  expect(me.status()).toBe(401);
  expect(await me.json()).toMatchObject({ code: 30004, data: null });

  await page.goto("/overview", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/login\?next=%2Foverview$/);
  await assertIsAppUnderTest(page);
  await expect(page.getByRole("button", { name: /GitHub/i })).toBeVisible();
});

test("真实 session 打开控制台并呈现隔离用户与真实空态", async ({
  context,
  page,
}) => {
  const handoff = readHandoff();
  await authenticate(context);
  await page.goto("/overview");

  await expect(page.getByText(`webe2e ${handoff.runID}`).first()).toBeVisible();
  await expect(page.getByTestId("overview-tiles")).toBeVisible();
  await expect(page.getByTestId("empty-agents")).toBeVisible();

  const [agents, devices, follows] = await Promise.all([
    page.request.get("/v1/workspace/agents"),
    page.request.get("/v1/devices"),
    page.request.get("/v1/follows"),
  ]);
  expect((await agents.json()).data.agents).toEqual([]);
  expect((await devices.json()).data.devices).toEqual([]);
  expect((await follows.json()).data.items).toEqual([]);
});

test("完整设备授权经真实 API、CSRF 和 SQL 持久化且 device code 只能消费一次", async ({
  context,
  page,
}) => {
  const authorization = await authorizeDevice(page);

  await authenticate(context);
  await page.goto(authorization.verification_uri_complete);
  await expect(page.getByText(authorization.user_code)).toBeVisible();
  await expect(page.getByText(/linux · e2e/i)).toBeVisible();
  await page.getByRole("button", { name: /允许授权|Allow access/i }).click();
  await expect(
    page.getByRole("heading", { name: /设备已授权|Device authorized/i }),
  ).toBeVisible();

  const first = await exchangeDeviceCode(page, authorization.device_code);
  expect(first.token).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
    device_id: expect.any(Number),
  });

  const oracle = readOracle();
  expect(oracle.flows).toHaveLength(1);
  expect(oracle.flows[0]).toMatchObject({
    device_kind: "desktop",
    authorized_user_id: oracle.user_id,
    denied_at: 0,
  });
  expect(oracle.flows[0].approved_at).toBeGreaterThan(0);
  expect(oracle.flows[0].consumed_at).toBeGreaterThan(0);
  expect(oracle.devices).toEqual([
    expect.objectContaining({
      id: first.token?.device_id,
      kind: "desktop",
      status: 1,
    }),
  ]);
  expect(oracle.tokens).toEqual([
    expect.objectContaining({
      device_id: first.token?.device_id,
      refresh_expires_at: expect.any(Number),
      revoked_at: 0,
    }),
  ]);

  const second = await exchangeDeviceCode(page, authorization.device_code);
  expect(second.response.status()).toBe(400);
  expect(second.body).toMatchObject({ code: 30204, error: "invalid_grant" });
});

async function assertCorePagesDoNotOverflow(
  context: Parameters<typeof authenticate>[0],
  page: Parameters<typeof horizontalOverflow>[0],
) {
  await page.goto("/login");
  await assertIsAppUnderTest(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await authenticate(context);
  await page.goto("/overview");
  await expect(page.getByTestId("overview-tiles")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.goto("/device");
  await expect(page.getByRole("group")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
}

test("桌面浏览器布局无水平溢出", async ({ context, page }) => {
  await assertCorePagesDoNotOverflow(context, page);
});

test("移动浏览器布局无水平溢出", async ({ context, page }) => {
  await assertCorePagesDoNotOverflow(context, page);
});

test("正式嵌入式 SPA fallback 渲染 404，缺失 asset 保持 HTTP 404", async ({
  page,
}) => {
  await page.goto("/no-such-page");
  await expect(
    page.getByRole("heading", { name: /页面不存在|Page not found/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /回到首页|Back to home/i }),
  ).toBeVisible();

  const missingAsset = await page.request.get("/assets/no-such-asset.js");
  expect(missingAsset.status()).toBe(404);
  expect((await missingAsset.text()).toLowerCase()).not.toContain("<!doctype");
});
