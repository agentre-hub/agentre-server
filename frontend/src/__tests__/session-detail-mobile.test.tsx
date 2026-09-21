/**
 * 移动端会话详情页（屏 22 / 48c）：「关注 / 取消关注」这个概念已经作废
 * （2026-08-18-server-session-mirror.md 决策 5），详情页顶栏因此不再有那个开关。
 *   - 移动端顶栏没有 Follow / Unfollow，也不对 /v1/saved-sessions 这一族发任何请求。
 *   - 桌面（非移动）与右栏嵌入形态同样没有。
 *
 * 收进账号现在叫**保存**，入口在索引的机器轴那一档（决策 11），而且第一次保存要先
 * 把「内容会存在服务器上」说清楚（决策 2）——一个顶栏书签图标表达不了这件事，
 * 它调的那两个写端点（POST /v1/follows、POST /v1/follows/unfollow）也已经不在了。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { MemoryRouter } from "react-router-dom";
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
import { useRelayChannel } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import SessionDetailView from "@/components/session/SessionDetailView";
import ResolvedSessionDetail from "@/components/session/ResolvedSessionDetail";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);

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

function renderPage(
  props: { backTo?: string; relayState?: "connected" | "connecting" } = {},
) {
  mockUseRelay.mockImplementation(() => ({
    client: fakeClient as never,
    relayState: props.relayState ?? "connected",
    relayTicket: {
      peerFingerprint: "fp-web",
      clientName: "Browser",
      accessToken: "t",
      expiresAt: Date.now() + 120_000,
    },
    relayTicketError: null,
    handshakeRejection: null,
    reconnect: vi.fn(),
  }));
  return render(
    <MemoryRouter initialEntries={[`/chat/${CID}`]}>
      <ThemeProvider>
        <SessionDetailView
          deviceId={1}
          conversationId={CID}
          form="page"
          backTo={props.backTo}
        />
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
  it("顶栏没有关注开关,也不对 /v1/saved-sessions 发任何请求", async () => {
    mockMobileViewport();
    stubApi();
    renderPage();

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    // 「关注 / 取消关注」这两个词连同它们的动作一起作废:收进账号叫保存,入口在
    // 索引的机器轴上,而且第一次保存要先说清楚内容会被存下来。
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
    // 顶栏也不碰接替它的那一族端点:保存的入口在索引的机器轴上(决策 11),详情页
    // 既不保存、不删除,也不去读名单——留着一个静默失败的书签比没有按钮更糟。
    const savedSessionCalls = mockedApi.mock.calls.filter((c) =>
      String(c[0]).startsWith("/v1/saved-sessions"),
    );
    expect(savedSessionCalls).toEqual([]);
  });
});

describe("移动端会话详情：返回", () => {
  it("返回键在会话自己那一层头部里，回到宿主给的列表地址", async () => {
    mockMobileViewport();
    stubApi();
    renderPage({ backTo: "/chat?axis=agent" });

    const back = await screen.findByRole("link", { name: "Back" });
    expect(back.getAttribute("href")).toBe("/chat?axis=agent");
    expect(screen.getByTestId("session-detail-identity").contains(back)).toBe(
      true,
    );
  });

  it("宿主没给返回地址时回到 /chat", async () => {
    mockMobileViewport();
    stubApi();
    renderPage();

    const back = await screen.findByRole("link", { name: "Back" });
    expect(back.getAttribute("href")).toBe("/chat");
  });
});

/**
 * 一层头部（规格 2026-09-21-server-mobile-gaps 决策 3、问题 6）：此前手机上是页面
 * 顶栏（标题单行截断）+ 机器行（返回 + 机器 + 在线）+ 身份行三层约 190px，底部 tab
 * 仍常驻；窄于 420 时项目与机器整段被收掉，项目在详情屏哪里都看不到。
 */
describe("移动端会话详情：一层头部", () => {
  const workspaceAgents = [
    { sync_id: "ag-1", name: "后端 Agent", avatar_color: "agent-1" },
  ];
  const projects = [{ sync_id: "p-1", name: "登录重构", color: "agent-5" }];

  function stubWithIdentity(opts: { online?: boolean } = {}) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: opts.online ?? true }] };
      if (path === "/v1/workspace/agents") return { agents: workspaceAgents };
      if (path === "/v1/workspace/projects") return { projects };
      if (path === "/v1/agent-sessions") return { items: [] };
      if (
        typeof path === "string" &&
        path.startsWith("/v1/agent-sessions/transcript")
      )
        return { frames: [], cursor: 0, has_more: false };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [
            {
              ...summary,
              projectSyncId: "p-1",
              lastMessageAt: Date.now() - 60_000,
            },
          ],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
  }

  it("不画页面顶栏与底部 tab，只剩会话自己的一层", async () => {
    mockMobileViewport();
    stubWithIdentity();
    renderPage();

    await screen.findByTestId("session-detail-identity");
    expect(screen.queryByTestId("app-topbar")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Agentre Server" }),
    ).toBeNull();
    // 返回也在这一层里，不再单占一行。
    expect(screen.queryByRole("navigation", { name: "Back" })).toBeNull();
  });

  it("一行里：返回 · 标题（最多两行）· 副行 Agent · 项目 · 机器与在线 · ⋯", async () => {
    mockMobileViewport();
    stubWithIdentity();
    renderPage();

    const band = await screen.findByTestId("session-detail-identity");
    expect(within(band).getByRole("link", { name: "Back" })).toBeTruthy();
    const title = await within(band).findByRole("heading", {
      name: "重构登录页",
    });
    expect(title.className).toContain("line-clamp-2");
    expect(
      within(band).getByRole("button", { name: "More actions" }),
    ).toBeTruthy();

    await within(band).findByTestId("session-detail-meta-project");
    const meta = within(band).getByTestId("session-detail-meta");
    expect(
      [...meta.querySelectorAll("[data-testid^='session-detail-meta-']")].map(
        (el) => el.getAttribute("data-testid"),
      ),
    ).toEqual([
      "session-detail-meta-agent",
      "session-detail-meta-project",
      "session-detail-meta-machine",
      "session-detail-meta-updated",
    ]);
    expect(
      (await within(meta).findByTestId("session-detail-meta-agent"))
        .textContent,
    ).toContain("后端 Agent");
    expect(
      within(meta).getByTestId("session-detail-meta-project").textContent,
    ).toContain("登录重构");
    const machine = within(meta).getByTestId("session-detail-meta-machine");
    expect(machine.textContent).toContain("书房小主机");
    expect(machine.textContent).toContain("Online");
    // 窄屏截断而不收起：三段都要留在 DOM 里、读屏读得到（`hidden` 会把它们从
    // 可访问树里拿掉）。
    for (const part of meta.querySelectorAll("[data-part]")) {
      expect(part.className).not.toMatch(/hidden/);
    }
    // 不互相覆盖：每一段的内容都能收缩（min-w-0）并在自己那一格里截断，不再是
    // shrink-0 的内层顶出所在那一段、压到下一段上（「19分钟前」压住 Agent 名）。
    for (const part of meta.querySelectorAll("[data-part]")) {
      const content = part.lastElementChild as HTMLElement;
      expect(content.className).toContain("min-w-0");
      expect(content.className).toMatch(/overflow-hidden|truncate/);
      expect(content.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
    }
  });

  it("机器离线时副行如实说离线", async () => {
    mockMobileViewport();
    stubWithIdentity({ online: false });
    renderPage();

    const machine = await screen.findByTestId("session-detail-meta-machine");
    expect(machine.textContent).toContain("Offline");
  });

  it("状态不丢：正在连的指示与更多操作里的每一项都还在这一层", async () => {
    mockMobileViewport();
    stubWithIdentity();
    renderPage({ relayState: "connecting" });

    const band = await screen.findByTestId("session-detail-identity");
    expect(within(band).getByRole("status").textContent).toContain(
      "Connecting",
    );
    fireEvent.keyDown(
      within(band).getByRole("button", { name: "More actions" }),
      { key: "Enter" },
    );
    expect(
      await screen.findByRole("menuitem", { name: "Copy conversation ID" }),
    ).toBeTruthy();
  });

  it("加载失败（机器名单取不到）也不画顶栏与 tab，返回仍在", async () => {
    mockMobileViewport();
    mockedApi.mockRejectedValue(new Error("network down"));
    renderPage({ backTo: "/chat?axis=agent" });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("app-topbar")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Agentre Server" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Back" }).getAttribute("href"),
    ).toBe("/chat?axis=agent");
  });
});

/** 认机器的那一段（ResolvedSessionDetail）：加载中 / 找不到 / 读不到 同样一层。 */
describe("移动端按地址打开：加载 / 未找到 / 出错", () => {
  function renderResolved() {
    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState: "connected",
      relayTicket: null,
      relayTicketError: null,
      handshakeRejection: null,
      reconnect: vi.fn(),
    }));
    return render(
      <MemoryRouter initialEntries={[`/chat/${CID}`]}>
        <ThemeProvider>
          <ResolvedSessionDetail
            conversationId={CID}
            deviceParam={null}
            form="page"
            backTo="/chat?axis=agent"
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  function expectNoChromeWithBack() {
    expect(screen.queryByTestId("app-topbar")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Agentre Server" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Back" }).getAttribute("href"),
    ).toBe("/chat?axis=agent");
  }

  it("加载中", () => {
    mockMobileViewport();
    mockedApi.mockImplementation(() => new Promise(() => {}));
    const { container } = renderResolved();

    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    expectNoChromeWithBack();
  });

  it("未找到", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [] };
      if (String(path).startsWith("/v1/agent-sessions?conversation_id="))
        return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderResolved();

    expect(await screen.findByTestId("session-not-found")).toBeTruthy();
    expectNoChromeWithBack();
  });

  it("出错", async () => {
    mockMobileViewport();
    mockedApi.mockRejectedValue(new Error("network down"));
    renderResolved();

    expect(await screen.findByTestId("session-resolve-error")).toBeTruthy();
    expectNoChromeWithBack();
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
        peerFingerprint: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      handshakeRejection: null,
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

  it("整屏形态的返回行回到宿主给的列表地址", async () => {
    stubApi();
    renderPage({ backTo: "/chat" });

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back" }).getAttribute("href"),
    ).toBe("/chat");
  });

  it("桌面不走沉浸形态：顶栏标题与返回行照旧", async () => {
    stubApi();
    renderPage();

    const topbar = await screen.findByTestId("app-topbar");
    expect(await within(topbar).findByText("重构登录页")).toBeTruthy();
    const row = screen.getByRole("navigation", { name: "Back" });
    expect(await within(row).findByText("书房小主机")).toBeTruthy();
  });
});
