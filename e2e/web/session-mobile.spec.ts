/**
 * 移动视口下这套形态是否成立 —— 运行时验证从没在任何移动视口上跑过。
 *
 * 跑在 playwright.web.config.ts 的 mobile-chromium 档(Pixel 7,与冒烟轨道同一个
 * 设备描述符);其余 web/ 用例仍是桌面档。两件事只在移动上成立:
 *   - 下钻三联:设备 → 这台机器的对话 → 对话详情,关注入口在**详情页顶栏**而不是
 *     列表行尾(决策 16);
 *   - 会话列表按**状态**分组:等你处理置顶 → 运行中 → 已中断 → 其余(决策 12),
 *     而不是桌面那套按 Agent 分组。
 *
 * 「等你处理」是运行时状态,播种不出来:用第二个页面在会话上真发一条
 * e2e-tool-permission,让那一轮阻塞在审批上,并**保持那个页面开着** —— 它一关,
 * 中继通道随之关闭,那个 waiter 也就没了。
 */
import { expect, type Page } from "@playwright/test";

import {
  deviceIdByName,
  openMachineSessions,
  seededSessions,
  seededWorkspace,
  test,
  useEnglish,
} from "./harness";

/** 顶栏面包屑(移动形态下它同时是返回入口与关注入口所在)。 */
function topBar(page: Page) {
  return page.getByRole("navigation", { name: "Devices", exact: true });
}

test("移动:设备 → 这台机器的对话 → 对话详情三步下钻,关注入口在详情顶栏而不是列表行", async ({
  page,
}) => {
  const ws = seededWorkspace();
  const s = seededSessions();
  await useEnglish(page);

  // ── 第 1 步:设备页 ────────────────────────────────────────────────────
  await page.goto("/devices", { waitUntil: "domcontentloaded" });
  const deviceRow = page
    .locator('[data-testid^="device-row-"]')
    .filter({ hasText: ws.agentred_device_name });
  await deviceRow.getByTestId(/^device-expand-/).click();
  const viewLink = deviceRow.locator('[data-testid^="device-sessions-link-"]');
  await expect(viewLink).toBeVisible({ timeout: 15_000 });
  await viewLink.click();

  // ── 第 2 步:这台机器的对话 ────────────────────────────────────────────
  await expect(page).toHaveURL(/\/devices\/\d+\/sessions$/);
  await expect(topBar(page).getByRole("link", { name: "Back" })).toBeVisible();
  await expect(topBar(page)).toContainText(ws.agentred_device_name);
  // 在线态带文字,不只靠颜色。
  await expect(topBar(page)).toContainText("Online");

  const listRow = page.getByTestId(`session-row-${s.full_chain_id}`);
  await expect(listRow).toBeVisible({ timeout: 30_000 });
  // 决策 16:移动的列表行尾没有关注开关(行里一个按钮都没有,只有那条链接)。
  await expect(listRow.getByRole("button")).toHaveCount(0);
  // 触控目标:行本身不低于 44px。
  const box = await listRow.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // ── 第 3 步:对话详情 ──────────────────────────────────────────────────
  await listRow.click();
  await expect(page).toHaveURL(
    new RegExp(`/devices/\\d+/sessions/${s.full_chain_id}$`),
  );
  await expect(page.getByTestId("session-detail-transcript")).toBeAttached({
    timeout: 30_000,
  });

  // 关注入口在详情页顶栏(决策 16),并且真的写进了账号级名单 —— 点一下变成
  // 「取消关注」。
  const follow = topBar(page).getByRole("button", {
    name: "Follow",
    exact: true,
  });
  await expect(follow).toBeVisible();
  await follow.click();
  const unfollow = topBar(page).getByRole("button", {
    name: "Unfollow",
    exact: true,
  });
  await expect(unfollow).toBeVisible();
  // 复位:关注名单是账号级的,别把它留给后面的用例。
  await unfollow.click();
  await expect(follow).toBeVisible();

  // 三联的返回:详情 → 这台机器的对话。
  await topBar(page).getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/devices\/\d+\/sessions$/);
});

test("移动:会话列表按状态分组,等你处理置顶,状态都带文字", async ({
  page,
  context,
}) => {
  const ws = seededWorkspace();
  const s = seededSessions();
  const machineID = await deviceIdByName(page, ws.agentred_device_name);

  // 制造一条真的「等你处理」:阻塞在工具审批上的一轮。发起它的那个页面必须一直
  // 开着,waiter 活在那条中继通道上。
  const holder = await context.newPage();
  await useEnglish(holder);
  await holder.goto(`/devices/${machineID}/sessions/${s.full_chain_id}`, {
    waitUntil: "domcontentloaded",
  });
  const composer = holder.getByTestId("session-detail-composer");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill("e2e-tool-permission:bash");
  await holder.getByTestId("session-detail-send").click();
  await expect(holder.getByTestId("approve-tool-allow")).toBeAttached({
    timeout: 30_000,
  });

  try {
    await openMachineSessions(page, ws.agentred_device_name);
    const groups = page.locator("section[aria-label]");
    await expect(groups.first()).toBeVisible({ timeout: 30_000 });

    // 分组维度是状态,顺序是决策 12 的顺序(等你处理置顶)。
    await expect
      .poll(
        async () =>
          groups.evaluateAll((els) =>
            els.map((e) => e.getAttribute("aria-label")),
          ),
        { timeout: 30_000, message: "移动端应按状态分组,等你处理置顶" },
      )
      .toEqual(["Waiting for you", "Running", "Interrupted", "Others"]);

    const inGroup = (label: string, sessionID: number) =>
      page
        .getByRole("region", { name: label, exact: true })
        .getByTestId(`session-row-${sessionID}`);
    await expect(inGroup("Waiting for you", s.full_chain_id)).toBeVisible();
    await expect(inGroup("Running", s.running_id)).toBeVisible();
    await expect(inGroup("Interrupted", s.interrupted_id)).toBeVisible();
    await expect(inGroup("Others", s.legacy_id)).toBeVisible();

    // 分的是状态不是 Agent:Agent 名不构成分组(它落在行上)。
    await expect(
      page.getByRole("region", { name: ws.agent_ready_name }),
    ).toHaveCount(0);
    await expect(page.getByTestId(`session-row-${s.running_id}`)).toContainText(
      ws.agent_ready_name,
    );

    // 可访问性:四类状态各自带文字。
    await expect(
      page.getByTestId(`session-row-${s.full_chain_id}`),
    ).toContainText("Waiting for your input");
    await expect(page.getByTestId(`session-row-${s.running_id}`)).toContainText(
      "Running",
    );
    await expect(
      page.getByTestId(`session-row-${s.interrupted_id}`),
    ).toContainText("Interrupted");
    await expect(page.getByTestId(`session-row-${s.legacy_id}`)).toContainText(
      "Idle",
    );
  } finally {
    // 收尾:把那一轮批掉再关页面,不给后面的用例留一个阻塞中的审批。批准生效的
    // 判据是那张卡片消失(待决策已被解决),不按回显文本取元素 —— 同一条会话上
    // 可能已经有一段一模一样的回显(全链路那条用例也发过这句)。
    await holder.getByTestId("approve-tool-allow").click();
    await expect(holder.getByTestId("approve-tool-allow")).toHaveCount(0, {
      timeout: 30_000,
    });
    await holder.close();
  }
});
