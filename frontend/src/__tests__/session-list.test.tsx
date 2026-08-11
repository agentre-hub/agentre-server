/**
 * R5 测试接缝：会话列表（含 R7 未到达时的退化形态）+ T6 的会话行两行化（p5Orc）。
 *
 *  1. 新会话（带标题 + agentSyncId）归入对应 Agent 分组（名称 / 头像色来自块 1）。
 *  2. 老会话（无标题 / 无 Agent 标识）归入「未命名」分组，如实退化为
 *     「工作目录 · 后端 · 状态」，不猜、不填占位名。
 *  3. 行两行化：Row1 = 状态点(aria) + 标题 + 相对时间；Row2 = 设备 · 后端。
 *     设备名来自页面传入的 deviceName（可选）——不传就不编造，Row2 只剩后端。
 *  4. R12 桌面入口：关注开关在行尾。
 *
 * T6 的 sessionView 纯函数（matchesSessionFilter / unreadCount / recentTimestamp /
 * takeRecent / statusDotClass）也在这里守：它们决定筛选 chips 与「最近」的行为。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import SessionList from "@/components/session/SessionList";
import i18n from "@/i18n";
import {
  matchesSessionFilter,
  recentTimestamp,
  statusDotClass,
  takeRecent,
  unreadCount,
} from "@/lib/sessionView";
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
  updatedAt: 1754800000000,
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

// 运行中但不等待输入的会话(用于断言「Running」,与等待输入区分)。
const runningNoWait = {
  sessionId: 10,
  title: "跑测试",
  agentSyncId: "ag-1",
  cwd: "/srv/tests",
  backendType: "claudecode",
  lifecycleState: "running",
  latestSeq: 7,
};

function renderList(
  sessions: unknown[],
  deviceName?: string,
  opts?: {
    followed?: Set<number>;
    onToggleFollow?: (id: number) => void;
  },
) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <SessionList
          sessions={sessions as never}
          agents={agents}
          sessionPath={(id) => `/sessions/${id}`}
          deviceName={deviceName}
          followedSessionIds={opts?.followed}
          onToggleFollow={opts?.onToggleFollow}
        />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("会话列表:R5 列表与 R7 退化形态", () => {
  it("新会话归入 Agent 分组,显示标题 / 运行状态 / 等待输入", () => {
    renderList([newSession, idleNew, runningNoWait]);

    // Agent 分组名出现。
    expect(screen.getByRole("heading", { name: /后端 Agent/ })).toBeTruthy();
    // 标题出现。
    expect(screen.getByText("重构登录页")).toBeTruthy();
    expect(screen.getByText("修 bug")).toBeTruthy();
    // 运行状态与等待输入都以可见点 + aria 呈现(不只靠颜色)。
    expect(
      screen.getByRole("img", { name: "Waiting for your input" }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Interrupted" })).toBeTruthy();
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

  // R5 的第四项：每条会话显示「最后活动时间」。它的唯一真相源是执行端那台机器上的
  // daemon_sessions.updated_at，随 session.list 过线（wire SessionSummary.updatedAt）。
  it("会话行显示最后活动时间;缺这个字段的老会话不猜一个时刻", () => {
    const at = 1754800000000;
    renderList([{ ...newSession, updatedAt: at }, legacySession]);

    const stamp = document.querySelector(
      `time[datetime="${new Date(at).toISOString()}"]`,
    );
    expect(stamp).toBeTruthy();
    // 老会话没有 updatedAt：不渲染时间元素，不填占位时刻。
    expect(document.querySelectorAll("time").length).toBe(1);
  });
});

// T6 的会话行两行化（p5Orc SessionItem）：Row1 状态点 + 标题 + 相对时间，
// Row2 设备 · 后端。诚实数据：设备名来自调用方（设备页知道自己在哪台机器上），
// 不传 deviceName 就不编造，Row2 只剩后端。
describe("会话列表:行两行化(Row1 状态点+标题+相对时间, Row2 设备·后端)", () => {
  it("传入 deviceName 时 Row2 渲染「设备 · 后端」", () => {
    renderList([newSession], "书房小主机");
    expect(screen.getByText(/书房小主机 · claudecode/)).toBeTruthy();
  });

  it("不传 deviceName 时 Row2 只显示后端,不编造设备名", () => {
    renderList([newSession]);
    expect(screen.queryByText(/· claudecode/)).toBeNull();
    expect(screen.getByText("claudecode")).toBeTruthy();
  });

  it("老会话退化:标题就是上下文,Row2 不再重复印后端", () => {
    renderList([legacySession], "书房小主机");
    // 退化标题完整出现一次。
    expect(screen.getByText("/var/proj · codex · Idle")).toBeTruthy();
    // Row2 不重复（codex 只出现在退化标题里）。
    expect(screen.getAllByText(/codex/).length).toBe(1);
  });

  it("Row1 状态点颜色按状态:等待=琥珀/运行=绿/中断=红/其余=灰", () => {
    renderList([newSession, idleNew, runningNoWait, legacySession]);
    expect(screen.getByTestId("session-dot-42").className).toContain(
      "bg-status-waiting",
    );
    expect(screen.getByTestId("session-dot-10").className).toContain(
      "bg-status-running",
    );
    expect(screen.getByTestId("session-dot-9").className).toContain(
      "bg-status-error",
    );
    expect(screen.getByTestId("session-dot-8").className).toContain(
      "bg-status-idle",
    );
  });
});

// R12 的桌面入口：关注开关在会话列表的**行尾**（mockup 帧 45a）。移动端不在行里，
// 入口在对话详情页顶栏（决策 16），由 session-list-mobile 那一组守住。
describe("会话列表:R12 桌面关注开关", () => {
  it("行尾有关注开关,点它把这一条加入名单", async () => {
    const toggled: number[] = [];
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionList
            sessions={[newSession] as never}
            agents={agents}
            sessionPath={(id) => `/sessions/${id}`}
            followedSessionIds={new Set<number>()}
            onToggleFollow={(id) => toggled.push(id)}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );

    const btn = screen.getByRole("button", { name: "Follow" });
    btn.click();
    expect(toggled).toEqual([42]);
  });

  it("已关注的会话行尾是「取消关注」", () => {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionList
            sessions={[newSession] as never}
            agents={agents}
            sessionPath={(id) => `/sessions/${id}`}
            followedSessionIds={new Set<number>([42])}
            onToggleFollow={() => {}}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Unfollow" })).toBeTruthy();
  });

  it("不给 onToggleFollow 时不渲染开关(下钻之外的复用场景)", () => {
    renderList([newSession]);
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
  });
});

// T6 的 sessionView 纯函数：筛选 chips 与「最近」的行为从这里来。
describe("sessionView 纯函数(T6 筛选 / 最近 / 状态点)", () => {
  it("matchesSessionFilter:all 不过滤,running=运行中且不等待,unread=等待输入", () => {
    const running = { lifecycleState: "running", waitingForInput: false };
    const waiting = { lifecycleState: "running", waitingForInput: true };
    const idle = { lifecycleState: "idle", waitingForInput: false };
    expect(matchesSessionFilter(running, "all")).toBe(true);
    expect(matchesSessionFilter(waiting, "all")).toBe(true);
    expect(matchesSessionFilter(idle, "all")).toBe(true);
    // 正在等输入的不算「运行中」(未读置顶优先)。
    expect(matchesSessionFilter(running, "running")).toBe(true);
    expect(matchesSessionFilter(waiting, "running")).toBe(false);
    expect(matchesSessionFilter(idle, "running")).toBe(false);
    expect(matchesSessionFilter(running, "unread")).toBe(false);
    expect(matchesSessionFilter(waiting, "unread")).toBe(true);
  });

  it("unreadCount:只数等待输入的会话", () => {
    expect(
      unreadCount([{ waitingForInput: true }, { waitingForInput: false }, {}]),
    ).toBe(1);
  });

  it("recentTimestamp:取 updatedAt 与 followedAt 之新;皆缺时 0", () => {
    expect(recentTimestamp(100, 200)).toBe(200);
    expect(recentTimestamp(300, 200)).toBe(300);
    expect(recentTimestamp(undefined, 200)).toBe(200);
    expect(recentTimestamp(undefined, undefined)).toBe(0);
  });

  it("takeRecent:按 recent 降序取前 N,不足 N 全取", () => {
    const rows = [
      { key: "a", recent: 1 },
      { key: "b", recent: 3 },
      { key: "c", recent: 2 },
    ];
    expect(takeRecent(rows, 2).map((r) => r.key)).toEqual(["b", "c"]);
    expect(takeRecent(rows, 10).map((r) => r.key)).toEqual(["b", "c", "a"]);
  });

  it("statusDotClass:等待=琥珀,运行=绿,中断=红,其余=灰", () => {
    expect(
      statusDotClass({ lifecycleState: "running", waitingForInput: true }),
    ).toBe("bg-status-waiting");
    expect(statusDotClass({ lifecycleState: "running" })).toBe(
      "bg-status-running",
    );
    expect(statusDotClass({ lifecycleState: "interrupted" })).toBe(
      "bg-status-error",
    );
    expect(statusDotClass({ lifecycleState: "idle" })).toBe("bg-status-idle");
    // 不认识的旧状态如实归灰,不猜。
    expect(statusDotClass({ lifecycleState: "weird" })).toBe("bg-status-idle");
  });
});
