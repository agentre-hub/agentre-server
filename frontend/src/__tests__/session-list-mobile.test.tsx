/**
 * 移动端会话列表（决策 12，测试接缝 6）：同一台机器的会话列表在移动上
 * **按状态分组**（等你处理置顶 → 运行中 → 已中断 → 其余），不按 Agent；
 * 桌面仍按 Agent（既有 session-list.test.tsx 覆盖）。
 *
 * 可访问性：运行 / 等待输入 / 已中断都有可见文字（不只靠颜色）。
 * 触控目标：移动行高不小于 44px（min-h-11），桌面行不受影响。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import SessionList from "@/components/session/SessionList";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";

const originalMatchMedia = window.matchMedia;

/** 把视口 mock 成移动（≤767px）。仅这一条查询匹配，其它（如深色偏好）不匹配。 */
function mockMobileViewport() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockMobileViewport();
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

const agents = [{ sync_id: "ag-1", name: "后端 Agent" }];

const waiting = {
  sessionId: 1,
  title: "等你批",
  agentSyncId: "ag-1",
  cwd: "/a",
  backendType: "claudecode",
  lifecycleState: "running",
  waitingForInput: true,
  latestSeq: 5,
};
const running = {
  sessionId: 2,
  title: "跑着呢",
  agentSyncId: "ag-1",
  cwd: "/b",
  backendType: "claudecode",
  lifecycleState: "running",
  latestSeq: 3,
};
const interrupted = {
  sessionId: 3,
  title: "断掉了",
  agentSyncId: "ag-1",
  cwd: "/c",
  backendType: "codex",
  lifecycleState: "interrupted",
  latestSeq: 2,
};
const idle = {
  sessionId: 4,
  title: "歇着",
  agentSyncId: "ag-1",
  cwd: "/d",
  backendType: "claudecode",
  lifecycleState: "idle",
  latestSeq: 1,
};
// R7 未到达的老会话：没有标题、没有 Agent 标识。
const legacy = {
  sessionId: 5,
  cwd: "/var/proj",
  backendType: "codex",
  lifecycleState: "idle",
  latestSeq: 1,
};

function headings(): string[] {
  return Array.from(document.querySelectorAll("h2")).map(
    (h) => h.textContent ?? "",
  );
}

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

describe("移动端会话列表:按状态分组(决策 12)", () => {
  it("等你处理置顶 → 运行中 → 已中断 → 其余,顺序固定", () => {
    renderList([idle, interrupted, running, waiting]);
    const hs = headings();
    expect(hs[0]).toMatch(/Waiting for you/);
    expect(hs[1]).toMatch(/Running/);
    expect(hs[2]).toMatch(/Interrupted/);
    expect(hs[3]).toMatch(/Others/);
  });

  it("移动不按 Agent 分组:没有 Agent 名当分组标题", () => {
    renderList([running, idle]);
    expect(screen.queryByRole("heading", { name: /后端 Agent/ })).toBeNull();
  });

  it("老会话如实退化为「工作目录 · 后端 · 状态」并归入其余分组", () => {
    renderList([legacy, running]);
    expect(screen.getByText("/var/proj · codex · Idle")).toBeTruthy();
    const hs = headings();
    expect(hs[hs.length - 1]).toMatch(/Others/);
  });

  it("运行 / 等待输入 / 已中断都有可见文字(不只靠颜色)", () => {
    renderList([waiting, running, interrupted]);
    // 等待输入的行徽标。
    expect(screen.getAllByText("Waiting for your input").length).toBe(1);
    // 运行 / 已中断 的分组标题就是文字。
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Interrupted").length).toBeGreaterThan(0);
  });

  it("移动行高满足触控目标(行不小于 44px),桌面行不强制", () => {
    renderList([running]);
    const link = screen.getByText("跑着呢").closest("a");
    expect(link?.className ?? "").toMatch(/min-h-11/);
  });
});
