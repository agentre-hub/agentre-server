/**
 * R11b —— 运行时验证里剩下的三态,以及「重连后自动补齐」。
 *
 * 规格要求四种情形各自给出**不同的说明**、不折叠成同一个错误。已被解除授权那一态
 * 由别处覆盖(设备解除授权的用例),这里验另外三态 + 自动补齐:
 *
 *   1. 目标 agentred 离线   —— 播种里那台永远不上线的机器就是它;
 *   2. 浏览器与 server 断线 —— 用 Playwright 拦下 /v1/relay/client 这条 WebSocket
 *      并当场切断,连重连尝试一起挡住,页面因此停在「正在重连」;放行后自动连回;
 *   3. 账号已登出           —— 清掉浏览器的会话 cookie,页面探测原因时得到 401。
 *
 * 自动补齐:断连期间由**另一个浏览器页**在同一条会话上发一轮,断线那一页在重连后
 * 必须自己把这段补齐 —— 不需要用户手动刷新(用一个页面内标记守着:刷新会把它冲掉)。
 *
 * 可访问性:三态都以文字呈现,断言的是文案本身,不是颜色。
 */
import { expect, type Page, type WebSocketRoute } from "@playwright/test";

import {
  deviceIdByName,
  seededSessions,
  seededWorkspace,
  test,
  useEnglish,
} from "./harness";

const FAKE_PREFIX = "e2e-fake-reply: ";

/** 三态各自的文案(frontend/src/i18n/locales/en.json 的 session.status.*)。 */
const COPY = {
  reconnecting: "Connection interrupted — reconnecting…",
  loggedOut: "You have been signed out. Please sign in again.",
  machineOffline: "This machine is offline",
};

/**
 * 本文件观察到的三态文案。规格的「各自给出不同的说明,不折叠成同一个错误」是一条
 * **跨状态**的断言,只能这样攒起来一起验(最后一个用例)。
 */
const observed = new Map<string, string>();

function banner(page: Page) {
  return page.locator("[data-session-status]");
}

/** 记下这一态的文案,顺带守住「不只靠颜色」——文案必须真有字。 */
async function recordCopy(page: Page, status: string): Promise<string> {
  const text = ((await banner(page).textContent()) ?? "").trim();
  expect(text.length).toBeGreaterThan(0);
  observed.set(status, text);
  return text;
}

/**
 * 让这一页的中继连接可以被就地切断。
 *
 * 拦的只是**浏览器与 server 之间**那条 socket(page 级路由),同上下文的别的页面
 * 照常直连 —— 断连期间还得有人在那台 agentred 上干活,补齐才有东西可补。
 */
async function severableRelay(page: Page) {
  let blocking = false;
  let live: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/v1\/relay\/client/, (ws) => {
    if (blocking) {
      // 重连尝试也连不上:页面因此停在「正在重连」,而不是 1s 后自己好了。
      void ws.close();
      return;
    }
    live.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    // 关闭不带 code 转发:1005/1006 这类状态码是不能主动发出去的。
    ws.onClose(() => void server.close());
    server.onClose(() => void ws.close());
  });
  return {
    async cut() {
      blocking = true;
      const open = live;
      live = [];
      for (const ws of open) await ws.close();
    },
    restore() {
      blocking = false;
    },
  };
}

/** 打开一条会话的详情页并等到它可用(已 attach + 已补齐 + 可发消息)。 */
async function openSession(
  page: Page,
  deviceID: number,
  sessionID: number,
): Promise<void> {
  await useEnglish(page);
  await page.goto(`/devices/${deviceID}/sessions/${sessionID}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("session-detail-transcript")).toBeAttached({
    timeout: 30_000,
  });
  await expect(page.getByTestId("session-detail-composer")).toBeEnabled({
    timeout: 30_000,
  });
}

test("R11b:目标 agentred 离线时就地说明是那台机器离线", async ({ page }) => {
  const ws = seededWorkspace();
  await useEnglish(page);
  const offlineID = await deviceIdByName(page, ws.offline_device_name);

  // 设备页上就已经带文字说明(不只靠颜色):离线的机器不可进入。
  await page.goto("/devices", { waitUntil: "domcontentloaded" });
  const row = page
    .locator('[data-testid^="device-row-"]')
    .filter({ hasText: ws.offline_device_name });
  await row.getByTestId(/^device-expand-/).click();
  await expect(row).toContainText("Offline — conversations are unavailable.", {
    timeout: 15_000,
  });

  // 直达那台机器的会话页:说的是「这台机器离线」,不是一句笼统的连接失败。
  await page.goto(`/devices/${offlineID}/sessions`, {
    waitUntil: "domcontentloaded",
  });
  await expect(banner(page)).toHaveAttribute(
    "data-session-status",
    "machineOffline",
    { timeout: 30_000 },
  );
  await expect(banner(page)).toContainText(COPY.machineOffline);
  await recordCopy(page, "machineOffline");
});

test("R11b:与 server 断线时说明可自动重连,放行后自己连回来", async ({
  page,
}) => {
  const ws = seededWorkspace();
  const s = seededSessions();
  const relay = await severableRelay(page);
  const machineID = await deviceIdByName(page, ws.agentred_device_name);
  await openSession(page, machineID, s.full_chain_id);
  // 连着的时候没有任何状态横幅 —— 正常态不该也挂一条。
  await expect(banner(page)).toHaveCount(0);

  await relay.cut();
  await expect(banner(page)).toHaveAttribute(
    "data-session-status",
    "reconnecting",
    { timeout: 30_000 },
  );
  await expect(banner(page)).toHaveText(COPY.reconnecting);
  await recordCopy(page, "reconnecting");

  // 自动重连:放行之后不需要任何用户动作,横幅自己消失、又能发消息了。
  relay.restore();
  await expect(banner(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("session-detail-composer")).toBeEnabled();
});

test("R11b:重连后自动补齐断连期间的事件,不需要手动刷新", async ({
  page,
  context,
}) => {
  const ws = seededWorkspace();
  const s = seededSessions();
  const relay = await severableRelay(page);
  const machineID = await deviceIdByName(page, ws.agentred_device_name);
  await openSession(page, machineID, s.full_chain_id);
  // 「没有手动刷新」的硬证据:这个标记只活在当前这份文档里,刷新会把它冲掉。
  await page.evaluate(() => {
    (window as unknown as { __webe2eNoReload?: string }).__webe2eNoReload =
      "kept";
  });

  // 断连期间干活的那一页:同一个账号、同一条会话,但它的 socket 没被拦。
  const other = await context.newPage();
  await openSession(other, machineID, s.full_chain_id);

  await relay.cut();
  await expect(banner(page)).toHaveAttribute(
    "data-session-status",
    "reconnecting",
    { timeout: 30_000 },
  );

  const message = "e2e-catchup-during-outage";
  const reply = `${FAKE_PREFIX}${message}`;
  await other.getByTestId("session-detail-composer").fill(message);
  await other.getByTestId("session-detail-send").click();
  await expect(other.getByText(reply, { exact: true })).toBeAttached({
    timeout: 30_000,
  });
  // 断着的那一页此刻什么都没收到 —— 后面出现的那一段只可能来自补齐。
  await expect(page.getByText(reply, { exact: true })).toHaveCount(0);

  relay.restore();
  await expect(page.getByText(reply, { exact: true })).toBeAttached({
    timeout: 60_000,
  });
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __webe2eNoReload?: string }).__webe2eNoReload,
    ),
  ).toBe("kept");
  await other.close();
});

test("R11b:账号已登出时说明须重新登录", async ({ page, context }) => {
  const ws = seededWorkspace();
  const s = seededSessions();
  const relay = await severableRelay(page);
  const machineID = await deviceIdByName(page, ws.agentred_device_name);
  await openSession(page, machineID, s.full_chain_id);

  // 账号会话没了(这个浏览器不再是登录状态)。清的是本用例自己的上下文:播种的那把
  // 会话钥匙是整轮共用的,不能在这里把它作废。
  await context.clearCookies();
  await relay.cut();

  await expect(banner(page)).toHaveAttribute(
    "data-session-status",
    "loggedOut",
    { timeout: 30_000 },
  );
  await expect(banner(page)).toHaveText(COPY.loggedOut);
  await recordCopy(page, "loggedOut");
});

test("R11b:三态各自给出不同的说明,不折叠成同一个错误", async () => {
  expect([...observed.keys()].sort()).toEqual([
    "loggedOut",
    "machineOffline",
    "reconnecting",
  ]);
  expect(new Set(observed.values()).size).toBe(3);
});
