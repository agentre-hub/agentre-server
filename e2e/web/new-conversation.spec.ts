/**
 * 从 web 发起新对话的全链路 —— R15 / R16 / R17(测试接缝 10 的第二个场景)。
 *
 * 真浏览器 + 真 agentre-server + 真 agentred。run-e2e-web.mjs 已经播好:
 *   - 账号级工作区:一个执行目标链是「本机档 → 在线 agentred」的 Agent、
 *     一个一档可用的都没有(本机 / 未配对 / 离线)的 Agent、一个项目及它在
 *     那台在线 agentred 上的路径;
 *   - 一台永不上线的 agentred 设备(离线那一档的指代对象)。
 *
 * 覆盖:
 *   R15 派发时跳过 device_id 为空的「本机」档、只在 agentred 里按序取第一档可用的;
 *       全部档不可用时逐档说明原因,不静默失败。
 *   R16 web 发起的对话整条住在那台 agentred 上,并**不经「关注」**出现在「对话」页。
 *   R17 **发起前**就说明 org / subagent / hook 用不了以及原因。
 *
 * 界面语言固定成 en(i18n 的 localStorage 探测键 agentre.lang),断言的是真实文案。
 */
import { expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";

import {
  agentredDB,
  agentredFP,
  seededWorkspace,
  test,
  webFP,
} from "./harness";

/** agentred.db 上属于本浏览器的会话条数(独立于 UI 的 oracle)。 */
function webSessionCount(): number {
  const db = new DatabaseSync(agentredDB, { readOnly: true });
  try {
    return (
      db
        .prepare(
          `SELECT count(*) AS n FROM daemon_sessions WHERE peer_fingerprint = ?`,
        )
        .get(webFP) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** 打开「对话」页的空态主动作 → 新对话弹层(屏 23/24/25 的唯一入口)。 */
async function openNewConversation(page: Page) {
  await page.addInitScript(() =>
    window.localStorage.setItem("agentre.lang", "en"),
  );
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Start your first conversation" })
    .click({ timeout: 30_000 });
  return page.getByRole("dialog");
}

test("R15:全部执行档都不可用时逐档说明原因,不静默失败", async ({ page }) => {
  const ws = seededWorkspace();
  const dialog = await openNewConversation(page);

  // 选 Agent 这一步就已经如实说了「没有可用的执行机器」。
  const blocked = dialog
    .getByRole("option")
    .filter({ hasText: ws.agent_blocked_name });
  await expect(blocked).toContainText("No available execution target");
  await blocked.click();

  // R15:三档按序逐档给出原因 —— 本机档跳过(浏览器语境下没有指代对象)、
  // 指纹不在账号里的未配对、在账号里但没连上中继的离线。
  await expect(dialog.getByText("Can't start right now")).toBeVisible({
    timeout: 30_000,
  });
  const tiers = dialog.locator("ul > li");
  await expect(tiers).toHaveCount(3);
  await expect(tiers.nth(0)).toContainText("This device");
  await expect(tiers.nth(0)).toContainText("Skipped for web dispatch");
  await expect(tiers.nth(1)).toContainText("Not paired");
  await expect(tiers.nth(2)).toContainText(ws.offline_device_name);
  await expect(tiers.nth(2)).toContainText("Offline");

  // 不静默失败也意味着走不下去:这一步没有「开始对话」。
  await expect(
    dialog.getByRole("button", { name: "Start conversation" }),
  ).toHaveCount(0);
});

test("R15d/R17/R16:跳过本机档落到 agentred、发起前说清三个工具不可用、发起后不经关注出现在「对话」页", async ({
  page,
}) => {
  const ws = seededWorkspace();
  const before = webSessionCount();
  const dialog = await openNewConversation(page);

  // ── R15d:跳过 device_id 为空的档,只在 agentred 里取第一档可用的 ──────────
  await dialog
    .getByRole("option")
    .filter({ hasText: ws.agent_ready_name })
    .click();
  await expect(
    dialog.getByText(`Will run on ${ws.agentred_device_name}`),
  ).toBeVisible({
    timeout: 30_000,
  });
  // 服务端计划的独立 oracle:第一档确实是被跳过的本机档,选中的是那台 agentred。
  const plan = await page.evaluate(async (syncID: string) => {
    const res = await fetch(
      `/v1/workspace/dispatch-target?agent_sync_id=${encodeURIComponent(syncID)}`,
      { credentials: "include" },
    );
    return (await res.json()).data;
  }, ws.agent_ready_sync_id);
  expect(plan.tiers[0].availability).toBe("skipped_for_web");
  expect(plan.chosen.device_fingerprint).toBe(agentredFP);

  // ── 选项目:只列得出那台机器上已配好路径的项目 ─────────────────────────
  await dialog.getByRole("option").filter({ hasText: ws.project_name }).click();
  await expect(
    dialog.getByText(
      `Will run on ${ws.agentred_device_name} · ${ws.project_path}`,
    ),
  ).toBeVisible({ timeout: 30_000 });

  // ── R17:**发起前**就把三个工具用不了这件事摆在确认步上 ────────────────
  const note = dialog.getByRole("note");
  await expect(note).toContainText("org / subagent / hook are not available", {
    timeout: 30_000,
  });
  await expect(note).toContainText("desktop");
  // 「发起前」的硬证据:此刻那台 agentred 上一条新会话都还没有。
  expect(webSessionCount()).toBe(before);

  // ── 发起 ──────────────────────────────────────────────────────────────
  const message = "e2e-web-new-conversation";
  await page.locator("#new-conversation-first-message").fill(message);
  await dialog.getByRole("button", { name: "Start conversation" }).click();

  // 派发成功 → 直接进这条对话的详情页。
  await page.waitForURL(/\/devices\/\d+\/sessions\/\d+$/, { timeout: 60_000 });
  const [, deviceID, sessionID] =
    /\/devices\/(\d+)\/sessions\/(\d+)$/.exec(page.url()) ?? [];
  expect(sessionID).toBeTruthy();

  // ── R16:整条住在那台 agentred 上(agentred.db oracle,server 一条都不存)──
  // 只多了一条:一次派发就是一条真会话,重试另起一条是本轮修过的失败形态。
  expect(webSessionCount()).toBe(before + 1);
  const db = new DatabaseSync(agentredDB, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT title, cwd, agent_sync_id, backend_type FROM daemon_sessions
         WHERE peer_fingerprint = ? AND peer_session_id = ?`,
      )
      .get(webFP, sessionID) as
      | {
          title: string;
          cwd: string;
          agent_sync_id: string;
          backend_type: string;
        }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.title).toBe(message);
    expect(row!.cwd).toBe(ws.project_path);
    expect(row!.agent_sync_id).toBe(ws.agent_ready_sync_id);
    // backend 也是选中那一档带过去的（播种的 agent_backend 行 type=claudecode）。
    expect(row!.backend_type).toBe("claudecode");
  } finally {
    db.close();
  }

  // ── R16:回「对话」页,这条自己发起的对话已经在那儿了 —— 全程没点过「关注」──
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const group = page.getByRole("region", { name: ws.agent_ready_name });
  const row = group.locator(
    `a[href="/devices/${deviceID}/sessions/${sessionID}"]`,
  );
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText(message);
  await expect(row).toContainText(ws.agentred_device_name);
});
