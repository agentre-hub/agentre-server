/**
 * 移动端会话详情页（决策 16，屏 22 / 48c）：关注入口在详情页顶栏，不在列表行。
 *   - 未关注时顶栏有 Follow，点击调 POST /v1/follows（参数 = 目标设备指纹 + 会话标识）。
 *   - 已关注时顶栏是 Unfollow，点击调 POST /v1/follows/unfollow。
 *   - 桌面（非移动）详情页不渲染关注按钮（桌面入口在列表行，R12）。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import SessionDetailView from "@/components/session/SessionDetailView";
import SessionDetail from "@/pages/SessionDetail";

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

const summary = {
  sessionId: 42,
  title: "重构登录页",
  agentSyncId: "ag-1",
  cwd: "/home/agent/proj",
  backendType: "claudecode",
  lifecycleState: "idle",
  latestSeq: 2,
};

const fakeClient = {
  request: vi.fn(),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockClear();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

function renderPage() {
  mockUseRelay.mockImplementation(() => ({
    client: fakeClient as never,
    relayState: "connected",
    webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
    webDeviceError: null,
  }));
  return render(
    <MemoryRouter initialEntries={["/devices/1/sessions/42"]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/devices/:deviceId/sessions/:sessionId"
            element={<SessionDetail />}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function stubApi(follows: Array<Record<string, unknown>>) {
  mockedApi.mockImplementation(async (path) => {
    if (path === "/v1/devices") return { devices: [deviceRow] };
    if (path === "/v1/follows") return { items: follows };
    if (path === "/v1/follows" || path === "/v1/follows/unfollow") return {};
    throw new Error("unexpected: " + path);
  });
  fakeClient.request.mockImplementation(async (method: string) => {
    if (method === "runtime.session.list")
      return { sessions: [summary], supportsSessionMetadata: true };
    if (method === "runtime.session.pendingWaiters")
      return { toolPermissions: [], askUserQuestions: [] };
    throw new Error("unexpected: " + method);
  });
}

describe("移动端会话详情:关注入口在顶栏(决策 16)", () => {
  it("未关注时顶栏有 Follow,点击调 /v1/follows", async () => {
    mockMobileViewport();
    stubApi([]);
    renderPage();

    const followBtn = await screen.findByRole("button", { name: "Follow" });
    fireEvent.click(followBtn);
    await waitFor(() => {
      const call = mockedApi.mock.calls.find(
        (c) => c[0] === "/v1/follows" && c[1]?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({
        device_fingerprint: "fp-1",
        session_id: "42",
      });
    });
    // 点击后本地翻成已关注。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unfollow" })).toBeTruthy(),
    );
  });

  it("已关注时顶栏是 Unfollow,点击调 /v1/follows/unfollow", async () => {
    mockMobileViewport();
    stubApi([
      {
        device_fingerprint: "fp-1",
        session_id: "42",
        followed_at: 1754000000000,
        invalid: false,
      },
    ]);
    renderPage();

    const unfollowBtn = await screen.findByRole("button", {
      name: "Unfollow",
    });
    fireEvent.click(unfollowBtn);
    await waitFor(() => {
      const call = mockedApi.mock.calls.find(
        (c) => c[0] === "/v1/follows/unfollow",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({
        device_fingerprint: "fp-1",
        session_id: "42",
      });
    });
    // 点击后本地翻成未关注。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Follow" })).toBeTruthy(),
    );
  });
});

describe("SessionDetailView embedded 形态(任务 5 重构边界)", () => {
  it("embedded 形态:移动视口下也不渲染关注按钮(关注入口不属于右栏嵌入详情)", async () => {
    mockMobileViewport();
    stubApi([]);
    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    }));
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} sessionId={42} form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    // 标题在嵌入式详情头部,不包 AppShell。
    expect(await screen.findByText("重构登录页")).toBeTruthy();
    // embedded 形态永不渲染关注按钮(页面顶栏的 Follow/Unfollow 只属于 form="page")。
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
  });
});

describe("桌面端会话详情(非移动)", () => {
  it("详情页顶栏不渲染关注按钮(桌面入口在列表行,R12)", async () => {
    // 不 mock 移动视口 → 默认桌面。
    stubApi([]);
    renderPage();

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
  });
});
