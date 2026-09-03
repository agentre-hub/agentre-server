/**
 * 移动端会话详情页（屏 22 / 48c）：「关注 / 取消关注」这个概念已经作废
 * （2026-08-18-server-session-mirror.md 决策 5），详情页顶栏因此不再有那个开关。
 *   - 移动端顶栏没有 Follow / Unfollow，也不对 /v1/follows 发任何请求。
 *   - 桌面（非移动）与右栏嵌入形态同样没有。
 *
 * 收进账号现在叫**保存**，入口在索引的机器轴那一档（决策 11），而且第一次保存要先
 * 把「内容会存在服务器上」说清楚（决策 2）——一个顶栏书签图标表达不了这件事，
 * 它调的那两个写端点（POST /v1/follows、POST /v1/follows/unfollow）也已经不在了。
 */
import { render, screen } from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
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
import { ThemeProvider } from "@agentre-hub/agentre-ui";
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

/** 这条对话的身份（决策 1）。 */
const CID = "11111111-1111-7111-8111-111111111111";

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
  conversationId: CID,
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
  // 镜像历史应用完之后由页面预置游标：替身缺了它，attach 那一串会当场抛错，
  // 而本文件的断言看不出来——替身要跟得上真客户端的形状。
  setCursor: vi.fn(),
  getCursor: vi.fn(() => 0),
  close: vi.fn(),
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockClear();
  fakeClient.setCursor.mockClear();
  fakeClient.getCursor.mockClear();
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
    relayTicket: {
      clientId: "fp-web",
      clientName: "Browser",
      accessToken: "t",
      expiresAt: Date.now() + 120_000,
    },
    relayTicketError: null,
    reconnect: vi.fn(),
  }));
  return render(
    <MemoryRouter initialEntries={[`/devices/1/sessions/${CID}`]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/devices/:deviceId/sessions/:conversationId"
            element={<SessionDetail />}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function stubApi() {
  mockedApi.mockImplementation(async (path) => {
    if (path === "/v1/devices") return { devices: [deviceRow] };
    if (path === "/v1/agent-sessions") return { items: [] };
    if (
      typeof path === "string" &&
      path.startsWith("/v1/agent-sessions/transcript")
    )
      return { frames: [], cursor: 0, has_more: false };
    throw new Error("unexpected: " + path);
  });
  fakeClient.request.mockImplementation(async (method: unknown) => {
    if (method === rpcMethods.sessionList) return { sessions: [summary] };
    if (method === rpcMethods.sessionPendingWaiters)
      return { toolPermissions: [], askUserQuestions: [] };
    throw new Error("unexpected: " + method);
  });
}

describe("移动端会话详情:「关注」已经作废(决策 5)", () => {
  it("顶栏没有关注开关,也不对 /v1/follows 发任何请求", async () => {
    mockMobileViewport();
    stubApi();
    renderPage();

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    // 「关注 / 取消关注」这两个词连同它们的动作一起作废:收进账号叫保存,入口在
    // 索引的机器轴上,而且第一次保存要先说清楚内容会被存下来。
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
    // 端点本身也没了(router 只留保存 / 删除 / 读名单):留着一个按了 404 的书签,
    // 比没有按钮更糟 —— 它的失败被静默吞掉,用户以为自己保存过了。
    const followCalls = mockedApi.mock.calls.filter((c) =>
      String(c[0]).startsWith("/v1/follows"),
    );
    expect(followCalls).toEqual([]);
  });
});

describe("SessionDetailView embedded 形态(任务 5 重构边界)", () => {
  it("embedded 形态:移动视口下也不渲染关注按钮(关注入口不属于右栏嵌入详情)", async () => {
    mockMobileViewport();
    stubApi();
    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState: "connected",
      relayTicket: {
        clientId: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      reconnect: vi.fn(),
    }));
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId={CID}
            form="embedded"
          />
        </ThemeProvider>
      </MemoryRouter>,
    );

    // 标题在嵌入式详情头部,不包 AppShell。
    expect(await screen.findByText("重构登录页")).toBeTruthy();
    // 关注开关已经作废,哪种形态都不该再出现它。
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
  });
});

describe("桌面端会话详情(非移动)", () => {
  it("详情页顶栏同样没有关注开关(决策 5:这个概念作废了)", async () => {
    // 不 mock 移动视口 → 默认桌面。
    stubApi();
    renderPage();

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
  });
});
