/**
 * 移动端「对话」页（决策 16，屏 20）：
 *   - 关注来的会话按状态分组（等你处理置顶），不按 Agent。
 *   - 关注入口不在列表行（在详情页顶栏）——移动行里没有 Follow / Unfollow 控件。
 *   - 列表行第二行仍是「机器 · 时间」（机器落在行上）。
 *   - 空态沿用屏 32：文案与「开始第一个对话」主按钮原样不动。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine, type UseRelayMachineResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import Chat from "@/pages/Chat";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);

const originalMatchMedia = window.matchMedia;

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

const agentred = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};
const agents = [
  {
    sync_id: "ag-1",
    name: "后端 Agent",
    avatar_color: "#4f46e5",
    has_available_target: true,
    exec_targets: [
      {
        rank: 1,
        device_name: "书房小主机",
        availability: "available",
        current: true,
        is_local_reference: false,
      },
    ],
  },
];
const waitingSummary = {
  sessionId: 42,
  title: "等你批",
  agentSyncId: "ag-1",
  cwd: "/home/agent/proj",
  backendType: "claudecode",
  lifecycleState: "running",
  waitingForInput: true,
  latestSeq: 2,
};
const runningSummary = {
  sessionId: 43,
  title: "跑着呢",
  agentSyncId: "ag-1",
  cwd: "/srv/app",
  backendType: "claudecode",
  lifecycleState: "running",
  latestSeq: 3,
};

const fakeClient = {
  request: vi.fn(),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

function connectedRelay(): UseRelayMachineResult {
  return {
    client: fakeClient as never,
    relayState: "connected",
    webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
    webDeviceError: null,
  };
}

function headings(): string[] {
  return Array.from(document.querySelectorAll("h2")).map(
    (h) => h.textContent ?? "",
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockMobileViewport();
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  fakeClient.request.mockReset();
  fakeClient.request.mockImplementation(async (method: string) => {
    if (method === "runtime.session.list")
      return { sessions: [waitingSummary, runningSummary] };
    throw new Error("unexpected method: " + method);
  });
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <ThemeProvider>
        <Routes>
          <Route path="/chat" element={<Chat />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("移动端对话页:决策 12/16 + 空态屏 32", () => {
  it("关注来的会话按状态分组,等你处理置顶", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
            {
              device_fingerprint: "fp-1",
              session_id: "43",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    const hs = headings();
    expect(hs[0]).toMatch(/Waiting for you/);
    expect(hs[1]).toMatch(/Running/);
    // 移动不按 Agent 分组。
    expect(screen.queryByRole("heading", { name: /后端 Agent/ })).toBeNull();
  });

  it("移动列表行没有关注开关(入口在详情页顶栏,决策 16)", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
  });

  it("列表行第二行仍是「机器 · 时间」(机器落在行上)", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.getByText(/书房小主机 · /)).toBeTruthy();
  });

  // R13：「桌面按 Agent 分组，**移动的列表行本身就以 Agent 命名**」。移动按状态
  // 分组，分组标题里没有 Agent，因此名称与头像必须落在行上（设计稿屏 20 的 ChatItem
  // 第一行就是 Agent 名）；否则移动端整屏看不出哪条对话属于哪个 Agent。
  it("移动行以 Agent 命名(名称 + 头像落在行上)", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    // 分组仍按状态（决策 12），Agent 不是分组维度。
    expect(screen.queryByRole("heading", { name: /后端 Agent/ })).toBeNull();
    // 但行上带着它。
    const row = screen.getByText("等你批").closest("a");
    expect(row?.textContent).toMatch(/后端 Agent/);
    expect(
      row?.querySelector('[data-testid="chat-row-avatar-42"]'),
    ).toBeTruthy();
  });

  it("空态沿用屏 32:文案与「开始第一个对话」主按钮原样不动", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows") return { items: [] };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    renderChat();

    expect(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    ).toBeTruthy();
    // 文案原样：屏 32 的标题 +正文一字不改。
    expect(screen.getByText("No conversations yet.")).toBeTruthy();
    expect(
      screen.getByText(
        "Pick an agent to get started. It works in the project directory you choose, and asks you before every step that needs permission.",
      ),
    ).toBeTruthy();
    // 主按钮打开新对话弹层（屏 23/24/25）。
    fireEvent.click(
      screen.getByRole("button", { name: "Start your first conversation" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Pick an agent" }),
      ).toBeTruthy(),
    );
  });

  it("移动端有会话时也有新建入口(FAB)打开新对话弹层(IC5sH)", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    // 列表在（有会话），FAB 是新建入口（设计稿屏 20 的 pen-line FAB）。
    expect(await screen.findByText("等你批")).toBeTruthy();
    const fab = screen.getByRole("button", {
      name: "Start your first conversation",
    });
    fireEvent.click(fab);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Pick an agent" }),
      ).toBeTruthy(),
    );
  });

  it("空态时也显示同一个真实搜索框（加载完成后不再因空隐藏），且不制造结果、不隐藏主空态", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows") return { items: [] };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    renderChat();

    // 主空态在（屏 32 文案与主按钮）。
    expect(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    ).toBeTruthy();

    // 回归：数据加载完成后，即使没有任何会话，移动端也显示同一个真实搜索框
    // （之前被 loaded && !empty 隐藏，运行时 light/dark 都找不到 searchbox）。
    const search = screen.getByRole("searchbox", {
      name: i18n.t("appShell.searchPlaceholder"),
    });

    // 输入不制造结果：没有任何会话行出现。
    fireEvent.change(search, { target: { value: "跑着呢" } });
    expect(screen.queryByText("跑着呢")).toBeNull();

    // 主空态不被隐藏，主按钮仍可用。
    expect(screen.getByTestId("chat-empty-state")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Start your first conversation",
      }),
    ).toBeTruthy();
  });

  it("移动端也有可触达的真实搜索（屏 20 头部搜索）：输入词过滤会话行", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
            {
              device_fingerprint: "fp-1",
              session_id: "43",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.getByText("跑着呢")).toBeTruthy();
    // 搜索是真实行为（matchesRowSearch 过滤本页会话行），不是假控件。
    const search = screen.getByRole("searchbox", {
      name: i18n.t("appShell.searchPlaceholder"),
    });
    fireEvent.change(search, { target: { value: "跑着呢" } });
    expect(screen.queryByText("等你批")).toBeNull();
    expect(screen.getByText("跑着呢")).toBeTruthy();
  });
});
