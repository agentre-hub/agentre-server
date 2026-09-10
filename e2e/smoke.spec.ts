import {
  addVirtualAuthenticator,
  assertIsAppUnderTest,
  authenticate,
  authenticateForPasskeys,
  authorizeDevice,
  exchangeDeviceCode,
  expect,
  horizontalOverflow,
  openAccountFromUserMenu,
  passkeyOrigin,
  readHandoff,
  readOracle,
  refreshDeviceToken,
  requestWithDeviceToken,
  revokeDeviceFromBrowserSession,
  revokeOtherSessions,
  signOutViaUserMenu,
  pushAndPullSyncObject,
  test,
} from "./fixtures/app";
import { driveWorkspaceJourney } from "./fixtures/workspace";

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
  await page.goto("/devices");
  await expect(page.getByTestId("add-device-guide")).toBeVisible();
  await page.goto("/chat");
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();

  const [agents, devices, follows] = await Promise.all([
    page.request.get("/v1/workspace/agents"),
    page.request.get("/v1/devices"),
    page.request.get("/v1/follows"),
  ]);
  expect((await agents.json()).data.agents).toEqual([]);
  expect((await devices.json()).data.devices).toEqual([]);
  expect((await follows.json()).data.items).toEqual([]);
});

test("Web 核心业务经真实 Session、CSRF 与 MySQL 创建并在刷新后呈现", async ({
  context,
  page,
}) => {
  await authenticate(context);
  await driveWorkspaceJourney(page);
});

test("设备经授权、同步、刷新和撤销走完真实 HTTP 与 MySQL 生命周期", async ({
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

  const firstMe = await requestWithDeviceToken(
    page,
    "/v1/auth/me",
    first.token!.access_token,
  );
  expect(firstMe.status()).toBe(200);
  expect(await firstMe.json()).toMatchObject({
    code: 0,
    data: { user_id: oracle.user_id },
  });

  const synced = await pushAndPullSyncObject(page, first.token!.access_token);
  expect(readOracle().sync_objects).toContainEqual({
    sync_id: synced.syncID,
    kind: "project",
    version: synced.version,
    deleted_at: 0,
  });

  const refreshed = await refreshDeviceToken(page, first.token!.refresh_token);
  expect(refreshed.token).toMatchObject({
    access_token: expect.any(String),
    refresh_token: expect.any(String),
  });
  const refreshedMe = await requestWithDeviceToken(
    page,
    "/v1/auth/me",
    refreshed.token!.access_token,
  );
  expect(refreshedMe.status()).toBe(200);
  expect(await refreshedMe.json()).toMatchObject({
    code: 0,
    data: { user_id: oracle.user_id },
  });

  await revokeDeviceFromBrowserSession(page, first.token!.device_id);

  for (const accessToken of [
    first.token!.access_token,
    refreshed.token!.access_token,
  ]) {
    const rejected = await requestWithDeviceToken(
      page,
      "/v1/auth/me",
      accessToken,
    );
    expect(rejected.status()).toBe(401);
    expect(await rejected.json()).toMatchObject({ data: null });
  }

  const rejectedRefresh = await refreshDeviceToken(
    page,
    refreshed.token!.refresh_token,
  );
  expect(rejectedRefresh.response.status()).toBe(400);
  expect(rejectedRefresh.body).toMatchObject({
    code: 30204,
    error: "invalid_grant",
  });
  const revokedOracle = readOracle();
  expect(revokedOracle.tokens).toHaveLength(2);
  expect(revokedOracle.tokens.every((token) => token.revoked_at > 0)).toBe(
    true,
  );
});

test("Chromium 虚拟认证器注册通行密钥，再用它重新登录", async ({
  context,
  page,
}) => {
  // 只覆盖 Chromium：真实认证器（Touch ID、安全钥匙、跨设备扫码）没有 CDP 这条
  // 注入路径，无法自动化，留给收尾时的一次真机手动核对。
  const handoff = readHandoff();
  const origin = passkeyOrigin();
  await addVirtualAuthenticator(context, page);
  await authenticateForPasskeys(context);

  await page.goto(`${origin}/account`);
  await expect(page.getByTestId("account-page")).toBeVisible();

  await page
    .getByRole("button", { name: /添加通行密钥|Add a passkey/i })
    .click();
  await page
    .getByPlaceholder(/公司 MacBook|Work MacBook/i)
    .fill("webe2e passkey");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^添加$|^Add$/ })
    .click();
  // 注册要走真实的 begin/finish 往返 + 虚拟认证器，断言可见性而不是等固定时长。
  await expect(page.getByText("webe2e passkey")).toBeVisible();

  // 清掉浏览器 cookie 是纯客户端动作、不触达服务端：种子会话在服务端仍然活着，
  // 后面「登录 → /account → 登出」那条用例还要用它。
  await context.clearCookies();
  await page.goto(`${origin}/login`);
  await page
    .getByRole("button", { name: /用通行密钥登录|Sign in with a passkey/i })
    .click();
  await page.waitForURL(/\/overview$/);

  // 换一条不经浏览器 UI 的路径核实登录的真是这个账号，而不是相信页面自己的说法。
  // 必须显式写上 origin：相对路径会拼到全局 baseURL（127.0.0.1）上，而通行密钥
  // 登录种下的 session cookie 没有 Domain 属性、只属于 localhost 这一个主机名，
  // 发到 127.0.0.1 上根本不带 cookie——那样拿到的 401 说的是「另一个 origin 没
  // 登录」，与本用例要核实的事情无关。
  const me = await page.request.get(`${origin}/v1/auth/me`);
  expect(me.status()).toBe(200);
  expect((await me.json()).data).toMatchObject({ user_id: handoff.userID });

  // 自行清理：删掉刚注册的那把密钥、登出这条通行密钥登录建立的新会话——全程
  // 不碰种子会话，不给这一轮的 Redis/MySQL 留残留。
  await page.goto(`${origin}/account`);
  await page.getByRole("button", { name: /删除|Remove/i }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^删除$|^Remove$/ })
    .click();
  await expect(page.getByText("webe2e passkey")).toHaveCount(0);
  await signOutViaUserMenu(page);
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

  // /account 是 T8 唯一没能核实横向溢出的页面：jsdom 不算布局，390 宽下真正的
  // 像素级检查只有这里（真实浏览器 + 移动 project）能做。
  await page.goto("/account");
  await expect(page.getByTestId("account-page")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
}

test("桌面浏览器布局无水平溢出", async ({ context, page }) => {
  await assertCorePagesDoNotOverflow(context, page);
});

test("移动浏览器布局无水平溢出", async ({ context, page }) => {
  await assertCorePagesDoNotOverflow(context, page);
});

test("登录后经用户菜单打开 /account，看见当前登录会话并能登出", async ({
  context,
  page,
}) => {
  await authenticate(context);
  // 前置条件由本用例自己建立：种子账号是整个 project 共用的，通行密钥那条用例
  // 会在它名下真的再建一个会话。撤掉其它会话之后「名下只剩当前这一个」才是本
  // 用例自己说了算的事实，而不是上一条用例收尾收干净了的副产物。
  await revokeOtherSessions(page);
  await page.goto("/overview");
  await expect(page.getByTestId("overview-tiles")).toBeVisible();

  await openAccountFromUserMenu(page);
  await expect(page.getByTestId("account-page")).toBeVisible();
  await expect(page.getByText(/当前会话|This session/)).toBeVisible();
  // 这一刻名下只有当前这一个会话：确认「当前会话」标在了对的那一行，且清单里
  // 没有第二行。
  await expect(
    page.getByText(/只有当前这一个会话|This is your only session/),
  ).toBeVisible();

  await signOutViaUserMenu(page);
  await expect(page).toHaveURL(/\/login/);

  // 换一条不经浏览器 UI 的路径核实登出是真的：会话已从服务端消失，不是页面自己
  // 假装跳转。
  const me = await page.request.get("/v1/auth/me");
  expect(me.status()).toBe(401);
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
