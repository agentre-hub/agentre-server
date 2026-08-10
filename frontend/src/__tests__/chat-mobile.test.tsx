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
    // 文案原样。
    expect(
      screen.getByText(
        "Start a new conversation, or open one you already have.",
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
});
