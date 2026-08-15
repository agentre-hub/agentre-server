/**
 * 移动端「这台机器的对话」页（屏 48b，下钻三联的中间一页）：
 * 顶栏 = 返回箭头（回设备页）+ 机器名 + 在线态；会话列表按状态分组（决策 12）。
 * 桌面形态（完整面包屑 + 换机器）由 device-sessions.test.tsx 覆盖。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import DeviceSessions from "@/pages/DeviceSessions";

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

const deviceRow = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};

const sessions = [
  {
    sessionId: 42,
    title: "等你批",
    agentSyncId: "ag-1",
    cwd: "/a",
    backendType: "claudecode",
    lifecycleState: "running",
    waitingForInput: true,
    latestSeq: 5,
  },
  {
    sessionId: 8,
    cwd: "/var/proj",
    backendType: "codex",
    lifecycleState: "idle",
    latestSeq: 5,
  },
];

const fakeClient = {
  request: vi.fn(async (method: string) => {
    if (method === "runtime.session.list") return { sessions };
    throw new Error("unexpected method: " + method);
  }),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockMobileViewport();
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  fakeClient.request.mockClear();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/devices/1/sessions"]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/devices/:deviceId/sessions"
            element={<DeviceSessions />}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function stubOnline() {
  mockedApi.mockImplementation(async (path) => {
    if (path === "/v1/devices") return { devices: [deviceRow] };
    if (path === "/v1/workspace/agents")
      return { agents: [{ sync_id: "ag-1", name: "后端 Agent" }] };
    throw new Error("unexpected: " + path);
  });
  mockUseRelay.mockReturnValue({
    client: fakeClient as never,
    relayState: "connected",
    relayTicket: {
      clientId: "fp-web",
      clientName: "Browser",
      accessToken: "t",
    },
    relayTicketError: null,
  });
}

describe("移动端「这台机器的对话」页(屏 48b)", () => {
  it("顶栏 = 返回箭头(回设备页) + 机器名 + 在线态", async () => {
    stubOnline();
    renderPage();

    expect(await screen.findByText("书房小主机")).toBeTruthy();
    const back = screen.getByRole("link", { name: "Back" });
    expect(back.getAttribute("href")).toBe("/devices");
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("会话列表按状态分组,等你处理置顶(决策 12)", async () => {
    stubOnline();
    renderPage();

    expect(await screen.findByText("等你批")).toBeTruthy();
    const hs = Array.from(document.querySelectorAll("h2")).map(
      (h) => h.textContent ?? "",
    );
    expect(hs[0]).toMatch(/Waiting for you/);
  });
});
