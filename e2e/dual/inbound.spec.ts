/**
 * 手工驱动验证 —— 浏览器 → 桌面端入站方向（桌面端作为可被寻址的执行端）。
 *
 * Spec: agentre/docs/specs/2026-08-11-desktop-peer-access.md（轮 B）
 * 验证对象：R1（登记可寻址）/ R4（设备页下钻会话列表）/ R6（接入实时流）/
 *           R7（历史补齐）/ R8（转录一致）/ R9（浏览器发消息进入下一轮，本机执行）。
 *
 * 两端：真 Wails 桌面端（wails dev -tags e2e，本地 CEO 会话跑 fake runtime）+
 *       真浏览器（agentre-server web 控制台，走中继接入桌面端会话）。
 * 本场景不涉及 agentred：桌面端 CEO 会话钉在本机（exec_device_id = 0）。
 *
 * 只经 `pnpm dual`（run-e2e-web.mjs --dual）跑；evidence 落 scratch/。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, type Locator, type Page } from "@playwright/test";

import {
  desktopSessionByTitle,
  desktopTranscript,
  desktopURL,
  test,
} from "./harness";

// 手工驱动也要录屏：默认 retain-on-failure 只在失败时留视频，这里显式 always 录。
test.use({ video: "on" });

const FAKE_PREFIX = "e2e-fake-reply: ";
const RUN = Date.now().toString(36);
const DESKTOP_OPENING = `e2e-inbound-opening-${RUN}`;
const WEB_MESSAGE = `e2e-inbound-web-${RUN}`;
const LOCAL_AGENT = "CEO 助手";
const DESKTOP_DEVICE = "webe2e-desktop";

const SHOT_DIR = join(
  "scratch",
  "2026-08-13-desktop-peer-access",
  "screenshots",
);

function trace(page: Page, who: string) {
  page.on("console", (m) => console.log(`[${who}:${m.type()}] ${m.text()}`));
  page.on("requestfailed", (r) =>
    console.log(`[${who}:reqfail] ${r.url()} → ${r.failure()?.errorText}`),
  );
}

function visible(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

async function shot(page: Page, name: string) {
  const path = join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`  [shot] ${path}`);
}

/** 桌面端在本地 CEO 会话上发一轮，等 fake 回显。 */
async function desktopSend(desktop: Page, text: string) {
  const editor = visible(desktop.locator(".ProseMirror"));
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.pressSequentially(text);
  await visible(
    desktop.getByRole("main").locator('button[type="submit"]'),
  ).click();
  await expect(
    visible(
      desktop.getByRole("main").getByText(`${FAKE_PREFIX}${text}`),
    ).first(),
  ).toBeVisible({ timeout: 90_000 });
}

test("浏览器接入桌面端会话：列出→补齐转录→发消息→收到回复", async ({
  page,
  browser,
}) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const desktop = await (await browser.newContext()).newPage();
  trace(page, "web");
  trace(desktop, "desktop");

  // ── 1. 桌面端本机建一条会话（这是浏览器将要接的那条）────────────────────
  await desktop.goto(desktopURL);
  await expect(desktop.getByTestId("new-chat-button")).toBeVisible({
    timeout: 60_000,
  });
  await desktop.getByTestId("new-chat-button").click();
  await desktop.getByTestId("new-agent-chat-item").click();
  await desktop
    .locator('[data-testid^="agent-picker-item-"]', { hasText: LOCAL_AGENT })
    .click();
  await expect(
    desktop.locator('[role="tab"][data-active="true"]'),
  ).toBeVisible();
  await desktopSend(desktop, DESKTOP_OPENING);

  // 会话确实落在这台桌面端、且钉在本机（本地执行，不是 agentred）。
  await expect
    .poll(() => desktopSessionByTitle(DESKTOP_OPENING)?.id ?? 0, {
      timeout: 30_000,
      message: "桌面端应有一条标题为首条消息的会话",
    })
    .toBeGreaterThan(0);
  const session = desktopSessionByTitle(DESKTOP_OPENING)!;
  expect(
    session.exec_device_id,
    "这一轮必须跑在桌面端本机，不是 agentred（exec_device_id=0）",
  ).toBe(0);
  await shot(desktop, "01-desktop-local-session");

  // ── 2. 浏览器：设备页看到桌面端在线（R1 登记可寻址）─────────────────────
  await page.goto("/devices", { waitUntil: "domcontentloaded" });
  const deviceRow = page
    .locator('[data-testid^="device-row-"]')
    .filter({ hasText: DESKTOP_DEVICE });
  await expect(deviceRow).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/v1/devices");
        const body = (await res.json()) as {
          data: { devices: { name: string; online: boolean }[] };
        };
        return body.data.devices.find((d) => d.name === DESKTOP_DEVICE)?.online;
      },
      { timeout: 60_000, message: "桌面端应在中继上登记为在线（可寻址）" },
    )
    .toBe(true);
  await shot(page, "02-web-devices-desktop-online");

  // ── 3. 浏览器下钻到桌面端会话列表（R4）──────────────────────────────────
  await deviceRow.getByTestId(/^device-expand-/).click();
  const viewLink = deviceRow.locator('[data-testid^="device-sessions-link-"]');
  await expect(viewLink).toBeAttached({ timeout: 30_000 });
  await viewLink.click();
  await expect(page).toHaveURL(/\/devices\/\d+\/sessions/);
  const sessionRow = page.getByTestId(`session-row-${session.id}`);
  await expect(sessionRow).toContainText(DESKTOP_OPENING, { timeout: 30_000 });
  await shot(page, "03-web-desktop-session-list");

  // ── 4. 接入：按游标补齐转录（R7/R8，桌面端历史不回收）───────────────────
  await sessionRow.click();
  await expect(page.getByTestId("session-detail-transcript")).toBeAttached({
    timeout: 30_000,
  });
  await expect(
    page.getByText(`${FAKE_PREFIX}${DESKTOP_OPENING}`, { exact: true }),
  ).toBeAttached({ timeout: 30_000 });
  await shot(page, "04-web-session-transcript");

  // ── 5. 浏览器发一条新消息，进入下一轮，在桌面端执行并回显（R9）──────────
  const composer = page.getByTestId("session-detail-composer");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(WEB_MESSAGE);
  await page.getByTestId("session-detail-send").click();
  await expect(
    page.getByText(`${FAKE_PREFIX}${WEB_MESSAGE}`, { exact: true }),
  ).toBeAttached({ timeout: 90_000 });
  await shot(page, "05-web-reply-received");

  // 独立 oracle：桌面端库里先落一行 user 消息，紧跟 assistant 回显。
  await expect
    .poll(
      () => {
        const rows = desktopTranscript(session.id);
        const i = rows.findIndex(
          (r) => r.role === "user" && r.blocks_json.includes(WEB_MESSAGE),
        );
        return (
          i >= 0 &&
          rows[i + 1]?.role === "assistant" &&
          rows[i + 1].blocks_json.includes(`${FAKE_PREFIX}${WEB_MESSAGE}`)
        );
      },
      {
        timeout: 30_000,
        message:
          "浏览器那一句应落成桌面端库里的一行 user 消息，且 assistant 行紧跟其后",
      },
    )
    .toBe(true);

  // R6b：同一份实时流 —— 桌面端自己的界面也看到浏览器发的那一句（带来源标识）。
  const desktopMain = desktop.getByRole("main");
  const userRow = visible(desktopMain.locator("article"))
    .filter({ hasText: WEB_MESSAGE })
    .filter({ hasNotText: FAKE_PREFIX });
  await expect(userRow, "桌面端界面应显示浏览器发来的用户消息").toHaveCount(1, {
    timeout: 90_000,
  });
  await expect(
    userRow,
    "R21:用户消息上应有「来自 <设备名>」来源标识",
  ).toContainText(/(来自|From)\s*Chrome/);
  await shot(desktop, "06-desktop-sees-web-message");
});
