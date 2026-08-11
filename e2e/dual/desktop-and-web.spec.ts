/**
 * DUAL-END e2e —— 一台 agentred,两个端同时接着:真 Wails 桌面端 + 真浏览器。
 *
 * 这是 spec docs/specs/2026-08-10-web-session-access.md 里那几条「必须两个端同时在场
 * 才看得见」的需求唯一的运行时观察点:
 *
 *   R7   桌面端发起每一轮时携带该会话当前的标题与它所属 Agent 的账号级同步标识,
 *        agentred 落库并在会话清单里回传。
 *   R18  浏览器在同一条会话上发的那条消息,在桌面端的转录里落成**一行正常的用户消息**
 *        —— 而不是退化成「一段没有提问的回复」(那与真·自主续轮在界面上同形)。
 *   R19  浏览器声明的设备显示名被桌面端渲染成来源标识「来自 <设备名>」。
 *   R6b  同一条会话同时被桌面端与浏览器接入,两边收到同一份实时流。
 *   R10b 同一个待决策只能被回答一次:已被别的端答过时,浏览器就地说明它已被处理。
 *
 * 两个端怎么接到同一台 agentred:
 *   - 浏览器:kind=web 设备 → GET /v1/relay/client?daemon_fingerprint=<fp>;
 *   - 桌面端:同一个账号的 kind=desktop 设备(e2e/fakes/login.go 播的登录态)+ 一条
 *     paired_agentreds 行与绑定它的 Agent(e2e/fakes/remote.go)→ 同一个中继端点。
 *   两边因此走同一条链路、认的是同一台机器,而不是各自走各自的传输。
 *
 * 断言一律「UI + 独立 oracle」两份证据:两个 SQLite(桌面端 agentre.db、agentred.db)
 * 都是绕开应用服务层直接读的。
 */
import { expect, type Locator, type Page } from "@playwright/test";

import {
  agentredJournalHas,
  agentredSession,
  desktopAgentSyncID,
  desktopFP,
  desktopSessionByTitle,
  desktopTranscript,
  desktopURL,
  test,
} from "./harness";

const FAKE_PREFIX = "e2e-fake-reply: ";
/** 与 agentre e2e/fakes/remote.go 的 RemoteAgentName 同值:跑在那台 agentred 上的 Agent。 */
const REMOTE_AGENT = "E2E Remote Agent";
/** fake runtime 的工具审批接缝:emit 一条 ToolPermissionRequest 后阻塞等决策。 */
const TOOL_DIRECTIVE = "e2e-tool-permission:bash";
/** 同一个接缝的另一用途:见 KEEPALIVE 那一步的说明(全程不批准,把这一轮挂住)。 */
const KEEPALIVE_DIRECTIVE = "e2e-tool-permission:keepalive";

const RUN = Date.now().toString(36);
const DESKTOP_OPENING = `e2e-desktop-opening-${RUN}`;
const WEB_MESSAGE = `e2e-web-message-${RUN}`;

/** 把两个端的 console / 失败请求都收进测试输出 —— 出问题时不必再猜。 */
function trace(page: Page, who: string) {
  page.on("console", (m) => console.log(`[${who}:${m.type()}] ${m.text()}`));
  page.on("requestfailed", (r) =>
    console.log(`[${who}:reqfail] ${r.url()} → ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`[${who}:res] ${r.status()} ${r.url()}`);
  });
}

/** 在桌面端用远端 Agent 新开一条会话。 */
async function desktopNewChat(desktop: Page) {
  await desktop.getByTestId("new-chat-button").click();
  await desktop.getByTestId("new-agent-chat-item").click();
  await desktop
    .locator('[data-testid^="agent-picker-item-"]', { hasText: REMOTE_AGENT })
    .click();
  await expect(
    desktop.locator('[role="tab"][data-active="true"]'),
  ).toBeVisible();
}

/**
 * 桌面端同时开着几条会话时,非活动 tab 的面板仍留在 DOM 里(composer、转录都在),
 * 所以本 spec 里所有桌面端定位一律只认**可见的那一份** —— 否则同一个选择器会同时
 * 命中另一条会话的同名元素。
 */
function visible(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

/** 在桌面端发一轮并等到 fake 的回显(工具审批接缝里回显先于阻塞)。 */
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

/** JSON-RPC 帧里没有 id 的就是服务端推送(通知);解不出来的按推送处理。 */
function isPush(raw: string | Buffer): boolean {
  try {
    const frame = JSON.parse(
      typeof raw === "string" ? raw : raw.toString("utf8"),
    ) as { id?: unknown };
    return frame?.id === undefined;
  } catch {
    return true;
  }
}

test("桌面端与浏览器同接一台 agentred:R7 落库回传、R18/R19 用户消息与来源标识、R6b 同一份实时流、R10b 已被处理", async ({
  page,
  browser,
}) => {
  const desktop = await (await browser.newContext()).newPage();
  trace(page, "web");
  trace(desktop, "desktop");

  // 浏览器的推送流开关:平时逐帧透传,R10b 那一步才按住(见那一段的说明)。
  // routeWebSocket 只对**之后**建立的连接生效,所以必须在第一次导航之前装。
  let holdPushes = false;
  await page.routeWebSocket(/\/v1\/relay\/client/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (holdPushes && isPush(m)) return;
      ws.send(m);
    });
  });

  await desktop.goto(desktopURL);
  await expect(desktop.getByTestId("new-chat-button")).toBeVisible({
    timeout: 60_000,
  });

  // ── 0. 先在这台 agentred 上挂住一轮:整场景要求桌面端**始终在场** ───────────
  //
  // 桌面端与一台 agentred 的连接和 remote.Runtime 都是「每轮借、轮末还」的:
  //   - 一轮结束后 chat_svc 释放 remoteCache 里那台设备的条目,池里的连接再空闲
  //     30 秒就被回收;
  //   - 下一次借用会 remote.New 出一个**新的** Runtime,它既不认识别的端在这台机器上
  //     跑的会话(hasSession 为假 → 提交决策当场 ErrNoActiveTurn),又会把 daemon 通知的
  //     handler 重新注册到同一条连接上,把上一实例上挂着的自主续轮消费方架空。
  // 于是「桌面端在场」这件事必须由一轮**还没结束**的轮次来维持 —— 真实世界里那就是
  // 一台机器上还有别的活儿在跑,这里用工具审批接缝造一轮:fake 回显之后阻塞等决策,
  // 我们全程不批准。两条都是产品既有行为,本任务只做验证、不改产品代码。
  await desktopNewChat(desktop);
  await desktopSend(desktop, KEEPALIVE_DIRECTIVE);
  await expect(
    visible(
      desktop.getByRole("main").getByTestId("tool-permission-card"),
    ).first(),
    "挂住那一轮必须真的停在待决策上(否则桌面端会在半路离场)",
  ).toBeVisible({ timeout: 90_000 });

  // ── 1. 桌面端在那台 agentred 上开本场景的会话(R7 的生产者)────────────────
  await desktopNewChat(desktop);
  await desktopSend(desktop, DESKTOP_OPENING);

  // 会话确实跑在远端(exec_device_id 非 0),标题取自首条消息。
  await expect
    .poll(() => desktopSessionByTitle(DESKTOP_OPENING)?.id ?? 0, {
      timeout: 30_000,
      message: "桌面端应有一条标题为首条消息的会话",
    })
    .toBeGreaterThan(0);
  const session = desktopSessionByTitle(DESKTOP_OPENING)!;
  expect(
    session.exec_device_id,
    "这一轮必须跑在配对的 agentred 上,不是本机",
  ).toBeGreaterThan(0);

  // R7:标题与 Agent 的账号级同步标识随这一轮过线,agentred 落了库。
  const agentSyncID = desktopAgentSyncID(session.agent_id);
  expect(agentSyncID, "桌面端的 Agent 必须有账号级同步标识").not.toBe("");
  await expect
    .poll(() => agentredSession(desktopFP, session.id)?.title ?? "", {
      timeout: 30_000,
      message: "R7:agentred 上这条会话应带着桌面端此刻的标题",
    })
    .toBe(DESKTOP_OPENING);
  const daemonRow = agentredSession(desktopFP, session.id)!;
  expect(
    daemonRow.agent_sync_id,
    "R7:落库的必须是账号级同步标识,不是本地自增 id",
  ).toBe(agentSyncID);

  // ── 2. 浏览器接进同一条会话 ───────────────────────────────────────────────
  await page.goto("/devices", { waitUntil: "domcontentloaded" });
  const deviceRow = page
    .locator('[data-testid^="device-row-"]')
    .filter({ hasText: "webe2e-agentred" });
  await deviceRow.getByTestId(/^device-expand-/).click();
  const viewLink = deviceRow.locator('[data-testid^="device-sessions-link-"]');
  await expect(viewLink).toBeAttached({ timeout: 30_000 });
  await viewLink.click();

  // R7 的另一半:标题在会话清单里被回传给浏览器。
  const sessionRow = page.getByTestId(`session-row-${session.id}`);
  await expect(sessionRow).toContainText(DESKTOP_OPENING, { timeout: 30_000 });
  await sessionRow.click();
  await expect(page.getByTestId("session-detail-transcript")).toBeAttached({
    timeout: 30_000,
  });
  // 桌面端那一轮的转录按游标补齐到浏览器上。
  await expect(
    page.getByText(`${FAKE_PREFIX}${DESKTOP_OPENING}`, { exact: true }),
  ).toBeAttached({ timeout: 30_000 });

  // ── 3. R18 / R19:浏览器在这条会话上发一句,桌面端落成一行正常的用户消息 ────
  //
  // 这条会话在桌面端只跑开场那一轮,此后由浏览器驱动:自主续轮的消费方
  // (startAutonomousWatcher)每会话只订阅一次(autoWatchers 去重),而它订阅的是
  // **当时那个** remote.Runtime 实例 —— 桌面端若在这条会话上再跑一轮,新实例会接管
  // daemon 通知,消费方却还挂在旧实例上,浏览器发起的这一轮就没人落库了。
  const composer = page.getByTestId("session-detail-composer");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(WEB_MESSAGE);
  await page.getByTestId("session-detail-send").click();

  // 桌面端转录里那一行:带问题、不带回复前缀 —— 正是「没有提问的回复」的反面。
  const desktopMain = desktop.getByRole("main");
  const userRow = visible(desktopMain.locator("article"))
    .filter({ hasText: WEB_MESSAGE })
    .filter({ hasNotText: FAKE_PREFIX });
  await expect(
    userRow,
    "R18:浏览器那一句必须在桌面端显示成一行用户消息",
  ).toHaveCount(1, { timeout: 90_000 });
  // R19:浏览器握手时声明的设备显示名(「Chrome · <平台>」)被渲染成来源标识。
  await expect(userRow, "R19:用户消息上应有「来自 <设备名>」").toContainText(
    /(来自|From)\s*Chrome/,
  );
  await expect(
    visible(desktopMain.getByText(`${FAKE_PREFIX}${WEB_MESSAGE}`)).first(),
  ).toBeVisible({ timeout: 90_000 });
  // R6b:同一份实时流 —— 这一轮的回复两端都看得到。
  await expect(
    page.getByText(`${FAKE_PREFIX}${WEB_MESSAGE}`, { exact: true }),
  ).toBeAttached({ timeout: 30_000 });

  // R18 的独立 oracle:桌面端库里 user 行真的存在,且 assistant 行紧跟其后。
  // 退化形态(只有一段没有提问的回复)在这里表现为 user 行根本不存在。
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
          "R18:桌面端库里应先有一行带该问题的 user 消息,紧跟着才是这一轮的 assistant 行",
      },
    )
    .toBe(true);
  const rows = desktopTranscript(session.id);
  const userIdx = rows.findIndex(
    (r) => r.role === "user" && r.blocks_json.includes(WEB_MESSAGE),
  );
  expect(userIdx, "R18:user 行必须真的落了库").toBeGreaterThanOrEqual(0);
  expect(rows[userIdx + 1]?.role).toBe("assistant");

  // ── 4. R10b:同一个待决策已被别的端答过时,浏览器就地说明它已被处理 ─────────
  await composer.fill(TOOL_DIRECTIVE);
  await page.getByTestId("session-detail-send").click();
  const webAllow = page.getByTestId("approve-tool-allow");
  await expect(webAllow, "浏览器应看到这次工具调用的审批卡").toBeAttached({
    timeout: 30_000,
  });
  const desktopCard = visible(
    desktopMain.getByTestId("tool-permission-card"),
  ).first();
  await expect(desktopCard, "R6b:同一张待决策在桌面端也在场").toBeVisible({
    timeout: 90_000,
  });

  // 从这一刻起按住浏览器收到的**推送**(请求/响应照常往返)。R10b 说的正是
  // 「本端还举着这张卡,而它已经被别的端答掉了」—— 真实世界里这个窗口由推送延迟
  // 造成,这里把它变成确定的:不按住的话,决议帧会先到、卡片自己就消失了,
  // 那一刻起谁也点不到它,这条需求就永远观察不到。
  holdPushes = true;
  await desktopCard
    .getByRole("button", { name: /^(Allow Once|仅本次允许)$/ })
    .click();
  // 「已被别的端答过」这个前提本身也要证据,而且要一份不经浏览器的:agentred 的
  // 通知日志里出现决议帧,才说明桌面端那一下真的送达并解开了阻塞中的工具调用。
  await expect
    .poll(
      () =>
        agentredJournalHas(desktopFP, session.id, "tool_permission_resolved"),
      {
        timeout: 60_000,
        message: "桌面端的批准必须真的送达 agentred(日志里应出现决议帧)",
      },
    )
    .toBe(true);

  // 浏览器手里还举着那张卡:点下去 → 预检发现它已不在待决清单里 → 就地说明。
  await webAllow.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /(已被处理|already been handled)/ }),
    "R10b:第二个端应就地说明该请求已被处理",
  ).toBeVisible({ timeout: 30_000 });
  holdPushes = false;
});
