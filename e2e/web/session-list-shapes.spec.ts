/**
 * R5b 的桌面形态 —— 运行时验证里唯一没被观察到的那半条需求。
 *
 * 真浏览器 + 真 agentre-server + 真 agentred(run-e2e-web.mjs 已编排)。这条 spec
 * 读的是 agentred.db 里被播种的四条会话:
 *   - 全链路那条(有标题、有 Agent 同步标识);
 *   - R7 到达之前的**老会话**:既没有标题也没有 Agent 标识;
 *   - 停在 running / interrupted 的两条,挂在播种工作区的那个 Agent 上。
 *
 * 验两件事(都只在真机上才成立 —— 分组维度取决于 daemon 交出的 agentSyncId,
 * Agent 名要经 /v1/workspace/agents 解析):
 *   1. 桌面按 **Agent** 分组,组名是解析出来的 Agent 名而不是同步标识本身;
 *   2. 老会话如实退化成「工作目录 · 后端 · 状态」并归入「未命名」分组 ——
 *      不猜标题、不填占位名。
 */
import { expect, type Page } from "@playwright/test";

import {
  openMachineSessions,
  seededSessions,
  seededWorkspace,
  test,
} from "./harness";

/** 等这台机器的会话列表连上中继并列出来(session.list 是连上之后才发的)。 */
async function openList(page: Page, machineName: string): Promise<void> {
  await openMachineSessions(page, machineName);
  await expect(page.locator("section[aria-label]").first()).toBeVisible({
    timeout: 30_000,
  });
}

test("R5b:桌面按 Agent 分组,组名是同步标识解析出来的 Agent 名", async ({
  page,
}) => {
  const ws = seededWorkspace();
  const s = seededSessions();
  await openList(page, ws.agentred_device_name);

  // 同一个 Agent 上的两条会话落在同一个分组里,组名是 /v1/workspace/agents 解析
  // 出来的名字 —— 而不是过线的那个同步标识。
  const group = page.getByRole("region", { name: ws.agent_ready_name });
  await expect(group.getByTestId(`session-row-${s.running_id}`)).toBeVisible();
  await expect(
    group.getByTestId(`session-row-${s.interrupted_id}`),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: s.agent_sync_id })).toHaveCount(
    0,
  );

  // 分的是 Agent,不是状态:桌面上没有状态分组(那是移动端的形态,决策 12)。
  for (const statusGroup of ["Waiting for you", "Running", "Interrupted"]) {
    await expect(
      page.getByRole("region", { name: statusGroup, exact: true }),
    ).toHaveCount(0);
  }

  // 可访问性:运行状态不只靠颜色 —— 每一行都带状态文字。
  await expect(page.getByTestId(`session-row-${s.running_id}`)).toContainText(
    "Running",
  );
  await expect(
    page.getByTestId(`session-row-${s.interrupted_id}`),
  ).toContainText("Interrupted");
});

test("R5b:R7 之前的老会话退化成「工作目录 · 后端 · 状态」并归入「未命名」,不猜标题", async ({
  page,
}) => {
  const ws = seededWorkspace();
  const s = seededSessions();
  await openList(page, ws.agentred_device_name);

  const unnamed = page.getByRole("region", { name: "Unnamed", exact: true });
  const row = unnamed.getByTestId(`session-row-${s.legacy_id}`);
  await expect(row).toBeVisible();

  // 标题这一行就是「工作目录 · 后端 · 状态」本身,逐字。
  await expect(row.locator("p").first()).toHaveText(
    `${s.legacy_cwd} · ${s.legacy_backend} · Idle`,
  );
  // 不猜、不填占位名:行里只有那一行文字,没有第二行副标题,也没有别处借来的名字。
  await expect(row.locator("p")).toHaveCount(1);
  await expect(row).not.toContainText(ws.agent_ready_name);
  await expect(row).not.toContainText(ws.project_name);

  // 有标题、有 Agent 的会话不该被扫进「未命名」。
  await expect(unnamed.getByTestId(`session-row-${s.running_id}`)).toHaveCount(
    0,
  );
  // 反过来:老会话也不该被塞进任何一个 Agent 分组。
  await expect(
    page
      .getByRole("region", { name: ws.agent_ready_name })
      .getByTestId(`session-row-${s.legacy_id}`),
  ).toHaveCount(0);
});
