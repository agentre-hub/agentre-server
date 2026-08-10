/**
 * R5 测试接缝：会话列表（含 R7 未到达时的退化形态）。
 *
 *  1. 新会话（带标题 + agentSyncId）归入对应 Agent 分组（名称 / 头像色来自块 1）。
 *  2. 老会话（无标题 / 无 Agent 标识）归入「未命名」分组，如实退化为
 *     「工作目录 · 后端 · 状态」，不猜、不填占位名。
 *  3. 运行状态 / 等待输入都有文字（不只靠颜色）。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import SessionList from "@/components/session/SessionList";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

const agents = [
  { sync_id: "ag-1", name: "后端 Agent", avatar_color: "#4f46e5" },
];

const newSession = {
  sessionId: 42,
  agentId: 7,
  title: "重构登录页",
  agentSyncId: "ag-1",
  cwd: "/home/agent/proj",
  backendType: "claudecode",
  lifecycleState: "running",
  waitingForInput: true,
  latestSeq: 12,
};

// R7 未到达的老会话：没有标题、没有 Agent 标识。
const legacySession = {
  sessionId: 8,
  agentId: 3,
  cwd: "/var/proj",
  backendType: "codex",
  lifecycleState: "idle",
  latestSeq: 5,
};

const idleNew = {
  sessionId: 9,
  title: "修 bug",
  agentSyncId: "ag-1",
  cwd: "/srv/app",
  backendType: "claudecode",
  lifecycleState: "interrupted",
  latestSeq: 3,
};

// 运行中但不等待输入的会话(用于断言「Running」文字,与等待输入区分)。
const runningNoWait = {
  sessionId: 10,
  title: "跑测试",
  agentSyncId: "ag-1",
  cwd: "/srv/tests",
  backendType: "claudecode",
  lifecycleState: "running",
  latestSeq: 7,
};

function renderList(sessions: unknown[]) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <SessionList
          sessions={sessions as never}
          agents={agents}
          sessionPath={(id) => `/sessions/${id}`}
        />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("会话列表:R5 列表与 R7 退化形态", () => {
  it("新会话归入 Agent 分组,显示标题 / 运行状态 / 等待输入", async () => {
    renderList([newSession, idleNew, runningNoWait]);

    // Agent 分组名出现。
    expect(screen.getByRole("heading", { name: /后端 Agent/ })).toBeTruthy();
    // 标题出现。
    expect(screen.getByText("重构登录页")).toBeTruthy();
    expect(screen.getByText("修 bug")).toBeTruthy();
    // 运行状态与等待输入都有文字。
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(screen.getAllByText("Waiting for your input").length).toBe(1);
  });

  it("老会话归入「未命名」分组,如实退化为「工作目录 · 后端 · 状态」", () => {
    renderList([legacySession, newSession]);

    expect(screen.getByRole("heading", { name: /Unnamed/ })).toBeTruthy();
    // 退化标题:工作目录 · 后端 · 状态(不猜标题、不填占位名)。
    expect(screen.getByText("/var/proj · codex · Idle")).toBeTruthy();
    // 新会话不因为老会话的存在而丢标题。
    expect(screen.getByText("重构登录页")).toBeTruthy();
  });

  it("Agent 分组内的会话行链到详情页", () => {
    renderList([newSession]);
    const row = screen.getByText("重构登录页").closest("a");
    expect(row?.getAttribute("href")).toBe("/sessions/42");
  });

  it("agentSyncId 存在但解析不到名字时如实显示标识,不猜占位名", () => {
    renderList([
      {
        sessionId: 3,
        title: "未知 Agent 的会话",
        agentSyncId: "ag-unknown",
        cwd: "/x",
        backendType: "codex",
        lifecycleState: "running",
        latestSeq: 1,
      },
    ]);
    expect(screen.getByRole("heading", { name: /ag-unknown/ })).toBeTruthy();
  });

  it("空列表给出空态文案", () => {
    renderList([]);
    expect(
      screen.getByText("No conversations on this machine yet."),
    ).toBeTruthy();
  });
});
