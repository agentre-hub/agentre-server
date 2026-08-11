/**
 * WEB FULL-CHAIN e2e —— 测试接缝 10:一次真实运行走通全链路。
 *
 * 真浏览器 + 本机真 agentre-server(开发环境 PG/Redis)+ 真 agentred(fake
 * runtime,字节稳定回复)。run-e2e-web.mjs 已经:
 *   - 播种一个一次性账号(PG)+ agentred 设备 + Redis 浏览器 session;
 *   - 写好已认领的 agentred state.json 并跑起 daemon(连上中继);
 *   - 在 agentred.db 里播种一条会话 + 三段旧转录日志(按游标补齐的素材)。
 *
 * 本 spec 只负责浏览器侧的五跳 + DB oracle:
 *   登录后取得设备身份 → 列出会话 → 按游标补齐转录 → 发新消息收到回复 → 批准工具调用。
 *
 * 确定性:
 *   - 浏览器指纹固定(WEBE2E_WEB_FINGERPRINT),与播种会话的 peer 指纹一致,
 *     于是这条会话归本浏览器所有、可 attach + 可 run;
 *   - 回复是 fake 的 e2e-fake-reply: 前缀,断言字节稳定;
 *   - 每个 hop 都用真实证据断言(UI + agentred.db / 服务器 /v1/devices oracle),
 *     不止 UI。
 */
import { expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";

import { agentredDB, seededSessions, test, webFP } from "./harness";

const FAKE_PREFIX = "e2e-fake-reply: ";

/** 服务器端 oracle:以 seed cookie 调 /v1/devices,断言存在 kind=web + 固定指纹。
 * 轮询等待(注册是页面 effect 里异步触发的,不是导航完成即就绪)。 */
async function assertWebDeviceRegistered(page: Page) {
  await expect
    .poll(
      async () => {
        return page.evaluate(async () => {
          const res = await fetch("/v1/devices", { credentials: "include" });
          if (!res.ok) return null;
          return (await res.json()).data.devices;
        });
      },
      {
        timeout: 30_000,
        message: "浏览器应按固定指纹注册成一台 kind=web 设备",
      },
    )
    .toContainEqual(
      expect.objectContaining({ fingerprint: webFP, kind: "web" }),
    );
}

test("全链路:登录→设备身份→列会话→游标补齐→发消息→收回复→批准工具调用", async ({
  page,
}) => {
  // 会话 id 只有 run-e2e-web.mjs 的播种那一份来源(经 WEBE2E_SESSIONS 透传):
  // 写死一个 1001 的话,播种改了 id 这条用例就对着一条不存在的会话跑。
  const SEEDED_SID = seededSessions().full_chain_id;
  // ── 诊断:网络失败 / 非 2xx / 浏览器 console 都进测试输出 ────────────────
  page.on("console", (msg) =>
    console.log(`[browser:${msg.type()}] ${msg.text()}`),
  );
  page.on("requestfailed", (r) =>
    console.log(`[reqfail] ${r.url()} → ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`[res] ${r.status()} ${r.url()}`);
  });

  // ── 跳 1a:登录 ────────────────────────────────────────────────────────
  // 访问设备页(seed session cookie 已带)。列表里应有 agentred(在线)。
  await page.goto("/devices", { waitUntil: "domcontentloaded" });
  const agentredName = page.getByText("webe2e-agentred", { exact: true });
  await expect(agentredName.first()).toBeAttached({ timeout: 30_000 });

  // ── 跳 1b:取得设备身份(经真实 RegisterWeb)────────────────────────────
  // 展开 agentred 设备 → 进入「这台机器的对话」。该页的 useRelayMachine 会
  // ensureWebDevice → POST /v1/oauth/device/register(按固定指纹幂等)。
  const row = page
    .locator('[data-testid^="device-row-"]')
    .filter({ hasText: "webe2e-agentred" });
  await row.getByTestId(/^device-expand-/).click();
  const viewLink = row.locator('[data-testid^="device-sessions-link-"]');
  await expect(viewLink).toBeAttached({ timeout: 15_000 });
  await viewLink.click();

  // 设备身份 hop 的显式证据:服务器 /v1/devices 里出现本浏览器的 kind=web 设备。
  await assertWebDeviceRegistered(page);

  // ── 跳 2:列出会话 ─────────────────────────────────────────────────────
  // 会话列表页连上中继后 session.list,应列出播种的那条会话。
  await expect(page.getByTestId(`session-row-${SEEDED_SID}`)).toBeAttached({
    timeout: 30_000,
  });

  // ── 跳 3:下钻 → 按游标补齐转录 ───────────────────────────────────────
  await page.getByTestId(`session-row-${SEEDED_SID}`).click();
  await expect(page.getByTestId("session-detail-transcript")).toBeAttached({
    timeout: 30_000,
  });
  // 补齐的旧转录(播种的 journal 行)必须在转录里出现。
  await expect(page.getByText("上次的旧转录(第 1 行)")).toBeAttached({
    timeout: 30_000,
  });
  await expect(page.getByText("上次的旧转录(第 2 行)")).toBeAttached();

  // ── 跳 4:发一条新消息并收到回复 ──────────────────────────────────────
  const composer = page.getByTestId("session-detail-composer");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  const message = `e2e hello from the web`;
  await composer.fill(message);
  await page.getByTestId("session-detail-send").click();
  // fake 回显:ReplyPrefix + 原样消息。
  await expect(
    page.getByText(`${FAKE_PREFIX}${message}`, { exact: true }),
  ).toBeAttached({ timeout: 30_000 });

  // ── 跳 5:批准一次工具调用 ────────────────────────────────────────────
  await composer.fill(`e2e-tool-permission:bash`);
  await page.getByTestId("session-detail-send").click();
  // fake emit ToolPermissionRequest → DecisionPanel 出现审批卡(工具名 bash)。
  const allowBtn = page.getByTestId("approve-tool-allow");
  await expect(allowBtn).toBeAttached({ timeout: 30_000 });
  await expect(page.getByText("bash").first()).toBeAttached();
  await allowBtn.click();
  // 审批投回 → ToolPermissionResolved + 收尾回显。
  await expect(
    page.getByText(`${FAKE_PREFIX}e2e-tool-permission:bash`, { exact: true }),
  ).toBeAttached({ timeout: 30_000 });

  // ── DB oracle:agentred.db ─────────────────────────────────────────────
  // 会话行 + 新轮次的 journal 都真实落了库(独立于 app 的服务层)。
  const db = new DatabaseSync(agentredDB, { readOnly: true });
  try {
    const sessionRow = db
      .prepare(
        `SELECT title, backend_type, lifecycle_state FROM daemon_sessions
         WHERE peer_fingerprint = ? AND peer_session_id = ?`,
      )
      .get(webFP, String(SEEDED_SID));
    expect(sessionRow).toBeTruthy();
    expect((sessionRow as { backend_type: string }).backend_type).toBe(
      "claudecode",
    );
    const journalCount = (
      db
        .prepare(
          `SELECT count(*) AS n FROM daemon_notification_logs
           WHERE peer_fingerprint = ? AND peer_session_id = ? AND seq > 3`,
        )
        .get(webFP, String(SEEDED_SID)) as { n: number }
    ).n;
    // 两轮新消息(普通 + 工具审批)各落了几条事件 + done,总 seq 一定越过 3。
    expect(journalCount).toBeGreaterThan(3);
  } finally {
    db.close();
  }
});
