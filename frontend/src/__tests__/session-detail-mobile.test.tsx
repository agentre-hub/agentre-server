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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  type InitialEntry,
  type Location,
  type NavigateFunction,
} from "react-router-dom";
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
import {
  useRelayChannel,
  type UseRelayChannelOptions,
} from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import SessionDetailView from "@/components/session/SessionDetailView";
import ResolvedSessionDetail from "@/components/session/ResolvedSessionDetail";
import { FILE_PREVIEW_LAYER_STATE_KEY } from "@/components/session/useFilePreviewTabs";

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

let pageOpts: UseRelayChannelOptions = {};

function renderPage(
  props: {
    backTo?: string;
    relayState?: "connected" | "connecting" | "reconnecting";
    onDelete?: () => void;
  } = {},
) {
  pageOpts = {};
  mockUseRelay.mockImplementation((_fp, opts) => {
    pageOpts = opts ?? {};
    return {
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
    };
  });
  return render(
    <MemoryRouter initialEntries={[`/chat/${CID}`]}>
      <ThemeProvider>
        <SessionDetailView
          deviceId={1}
          conversationId={CID}
          form="page"
          backTo={props.backTo}
          onDelete={props.onDelete}
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

  function stubWithIdentity(
    opts: { online?: boolean; summary?: Record<string, unknown> } = {},
  ) {
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
              ...opts.summary,
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

  it("一行里：返回 · 标题（一行）· ⋯；副标题「● 状态 · Agent · 机器」", async () => {
    mockMobileViewport();
    stubWithIdentity();
    renderPage();

    const band = await screen.findByTestId("session-detail-identity");
    expect(within(band).getByRole("link", { name: "Back" })).toBeTruthy();
    const title = await within(band).findByRole("heading", {
      name: "重构登录页",
    });
    expect(title.className).toContain("line-clamp-1");
    const head = screen.getByTestId("session-detail-header");
    expect(head.className).toMatch(/(^|\s)h-14(\s|$)/);
    expect(head.className).toMatch(/(^|\s)bg-sheet-header(\s|$)/);
    expect(
      within(band).getByRole("button", { name: "More actions" }),
    ).toBeTruthy();

    const meta = within(band).getByTestId("session-detail-meta");
    expect(
      [...meta.querySelectorAll("[data-testid^='session-detail-meta-']")].map(
        (el) => el.getAttribute("data-testid"),
      ),
    ).toEqual([
      "session-detail-meta-status",
      "session-detail-meta-agent",
      "session-detail-meta-machine",
    ]);
    expect(
      within(meta).getByTestId("session-detail-meta-status").textContent,
    ).toContain("Idle");
    expect(
      (await within(meta).findByTestId("session-detail-meta-agent"))
        .textContent,
    ).toContain("后端 Agent");
    expect(
      within(meta).getByTestId("session-detail-meta-machine").textContent,
    ).toContain("书房小主机");
    // 窄屏截断而不收起：三段都留在 DOM 里、读屏读得到。
    for (const part of meta.querySelectorAll("[data-part]")) {
      expect(part.className).not.toMatch(/hidden/);
    }
  });

  it("页头不放停止：这一轮在跑也没有；状态字写「Running」", async () => {
    mockMobileViewport();
    stubWithIdentity({ summary: { lifecycleState: "running" } });
    renderPage();

    const band = await screen.findByTestId("session-detail-identity");
    await waitFor(() =>
      expect(
        within(band).getByTestId("session-detail-meta-status").textContent,
      ).toContain("Running"),
    );
    expect(screen.queryByTestId("session-detail-stop")).toBeNull();
    expect(within(band).queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("出错的一轮写「Error」", async () => {
    mockMobileViewport();
    stubWithIdentity({ summary: { lifecycleState: "failed" } });
    renderPage();

    const band = await screen.findByTestId("session-detail-identity");
    await waitFor(() =>
      expect(
        within(band).getByTestId("session-detail-meta-status").textContent,
      ).toContain("Error"),
    );
  });

  it("通道正在（重）连时状态字写「Connecting」，进度条还在、文字只说一次", async () => {
    mockMobileViewport();
    stubWithIdentity();
    renderPage({ relayState: "reconnecting" });

    const band = await screen.findByTestId("session-detail-identity");
    await waitFor(() =>
      expect(
        within(band).getByTestId("session-detail-meta-status").textContent,
      ).toContain("Connecting"),
    );
    expect(await screen.findByTestId("connection-progress")).toBeTruthy();
    expect(within(band).getAllByText("Connecting")).toHaveLength(1);
  });

  it("机器离线时状态字写「Offline · 时间」", async () => {
    mockMobileViewport();
    stubWithIdentity({ online: false });
    renderPage();

    const status = await screen.findByTestId("session-detail-meta-status");
    await waitFor(() => expect(status.textContent).toMatch(/Offline · /));
  });

  it("⋯ 开「对话信息」弹层：项目 / 运行在 / 模型 / 最后活动，动作复制对话号", async () => {
    mockMobileViewport();
    stubWithIdentity({ summary: { providerKey: "p", modelKey: "glm-5.2" } });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderPage();

    const band = await screen.findByTestId("session-detail-identity");
    await within(band).findByTestId("session-detail-meta-agent");
    fireEvent.click(within(band).getByRole("button", { name: "More actions" }));

    const sheet = await screen.findByRole("dialog", {
      name: "Conversation info",
    });
    for (const label of ["Project", "Runs on", "Model", "Last active"]) {
      expect(within(sheet).getByText(label)).toBeTruthy();
    }
    expect(within(sheet).getByText("登录重构")).toBeTruthy();
    expect(within(sheet).getByText("书房小主机")).toBeTruthy();

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Copy conversation ID" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CID));
  });

  it("⋯ 弹层带「删除」（长按菜单里的删除在对话页 ⋯ 也有看得见的入口）；不给就不摆", async () => {
    mockMobileViewport();
    stubWithIdentity();
    const onDelete = vi.fn();
    const view = renderPage({ onDelete });

    const band = await screen.findByTestId("session-detail-identity");
    fireEvent.click(within(band).getByRole("button", { name: "More actions" }));
    const sheet = await screen.findByRole("dialog", {
      name: "Conversation info",
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Conversation info" }),
      ).toBeNull(),
    );

    view.unmount();
    renderPage();
    const band2 = await screen.findByTestId("session-detail-identity");
    fireEvent.click(
      within(band2).getByRole("button", { name: "More actions" }),
    );
    const sheet2 = await screen.findByRole("dialog", {
      name: "Conversation info",
    });
    expect(within(sheet2).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("转录：用户消息右对齐、统计行用紧凑档（手机）", async () => {
    mockMobileViewport();
    stubWithIdentity();
    renderPage();
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    act(() => {
      pageOpts.onEvent?.({
        conversationId: CID,
        event: { kind: "user_message", text: "你好" },
        seq: 1,
      } as never);
      pageOpts.onEvent?.({
        conversationId: CID,
        event: { kind: "text_delta", text: "收到" },
        seq: 2,
      } as never);
      pageOpts.onEvent?.({
        conversationId: CID,
        event: {
          kind: "done",
          model: "glm-5.2",
          durationMs: 1000,
          usage: { promptTokens: 1200, completionTokens: 33 },
        },
        seq: 3,
      } as never);
    });
    await screen.findByText("收到");
    expect(document.querySelector("[data-align='end']")).toBeTruthy();
    expect(
      document.querySelector("[data-meta-density='compact']"),
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
    // 返回那一格与落地后的头部同高同色：认出来之后换成真头部时它不跳。
    const row = screen.getByRole("link", { name: "Back" })
      .parentElement as HTMLElement;
    expect(row.className).toMatch(/(^|\s)h-14(\s|$)/);
    expect(row.className).toMatch(/(^|\s)bg-sheet-header(\s|$)/);
  });
});

/**
 * 底部停靠区（规格 2026-11-05「对话页 · 底部停靠区」，决策 7 / 8 / 9）：同一位置按
 * 状态换内容 —— 输入框（触屏档）/ 审批停靠 / 离线只读带。只在手机宽度。
 */
describe("移动端会话详情：底部停靠区", () => {
  function stubDock(opts: { online?: boolean; lifecycleState?: string } = {}) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: opts.online ?? true }] };
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
            { ...summary, lifecycleState: opts.lifecycleState ?? "idle" },
          ],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeSubmitToolPermission) return {};
      if (method === rpcMethods.runtimeAbort) return {};
      throw new Error("unexpected: " + method);
    });
  }

  function emit(events: Record<string, unknown>[]) {
    act(() => {
      events.forEach((event, i) =>
        pageOpts.onEvent?.({
          conversationId: CID,
          event,
          seq: i + 1,
        } as never),
      );
    });
  }

  const permission = {
    kind: "tool_permission_request",
    requestId: "tp-1",
    toolName: "Bash",
    input: { command: "pnpm add left-pad" },
  };

  it("空闲：停靠区是触屏档输入框，软键盘回车键标成换行", async () => {
    mockMobileViewport();
    stubDock();
    renderPage();

    const band = await screen.findByTestId("session-composer-band");
    const editor = await waitFor(() => {
      const el = band.querySelector<HTMLElement>(".ProseMirror");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // 触屏档的外壳带 data-shape（空时胶囊）；桌面档不带。
    expect(band.querySelector("[data-shape='pill']")).toBeTruthy();
    // 触屏上回车只换行（决策 9）：键面写「换行」，不写一个按下去做不到的「发送」。
    expect(editor.getAttribute("enterkeyhint")).toBe("enter");
  });

  it("等你审批：审批停靠在输入框的位置，转录里不再画那张卡，也没有键帽", async () => {
    mockMobileViewport();
    stubDock({ lifecycleState: "running" });
    renderPage();
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    emit([{ kind: "user_message", text: "装个依赖" }, permission]);

    const band = screen.getByTestId("session-composer-band");
    const dock = await within(band).findByTestId("tool-permission-dock");
    expect(within(dock).getByRole("button", { name: "Allow" })).toBeTruthy();
    // 输入框让位：同一位置只有一样东西。
    expect(band.querySelector(".ProseMirror")).toBeNull();
    expect(screen.queryByTestId("session-detail-composer")).toBeNull();
    // 转录里不再内联这张审批卡（决策 7），键帽也不画（触屏）。
    expect(
      within(screen.getByTestId("session-detail-scroll")).queryByTestId(
        "tool-permission-card",
      ),
    ).toBeNull();
    expect(document.querySelectorAll("kbd")).toHaveLength(0);

    fireEvent.click(within(dock).getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === rpcMethods.runtimeSubmitToolPermission,
      );
      expect(call?.[1]).toMatchObject({
        conversationId: CID,
        requestId: "tp-1",
        allow: true,
        alwaysAllowSession: false,
      });
    });
  });

  it("等你审批：停靠区底部「■ 停止」停这一轮，点下去转为停止中", async () => {
    mockMobileViewport();
    stubDock({ lifecycleState: "running" });
    renderPage();
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    emit([{ kind: "user_message", text: "装个依赖" }, permission]);

    const dock = await screen.findByTestId("tool-permission-dock");
    const stop = within(dock).getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    await waitFor(() =>
      expect(
        fakeClient.request.mock.calls.some(
          (c) => c[0] === rpcMethods.runtimeAbort,
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        (
          within(screen.getByTestId("tool-permission-dock")).getByRole(
            "button",
            { name: "Stop" },
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
  });

  it("Agent 的提问不停靠：留在转录里作答，输入框照旧", async () => {
    mockMobileViewport();
    stubDock({ lifecycleState: "running" });
    renderPage();
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    emit([
      { kind: "user_message", text: "选个库" },
      {
        kind: "ask_user_question",
        requestId: "aq-1",
        questions: [
          {
            id: "q1",
            question: "Which database?",
            header: "Storage",
            multiSelect: false,
            options: [{ label: "Postgres" }, { label: "Redis" }],
          },
        ],
      },
    ]);

    expect(await screen.findByText("Which database?")).toBeTruthy();
    expect(screen.queryByTestId("tool-permission-dock")).toBeNull();
    const band = screen.getByTestId("session-composer-band");
    await waitFor(() =>
      expect(band.querySelector(".ProseMirror")).toBeTruthy(),
    );
  });

  it("机器离线：只读带写「{机器} 回来后可以继续发消息 · 查看设备」，转录顶部没有离线横幅", async () => {
    mockMobileViewport();
    stubDock({ online: false });
    renderPage();

    const readonly = await screen.findByTestId("session-compose-readonly");
    expect(readonly.textContent).toContain("书房小主机 is back");
    const link = within(readonly).getByRole("link", { name: "View device" });
    expect(link.getAttribute("href")).toBe("/devices/1");
    expect(
      document.querySelector("[data-session-status='machineOffline']"),
    ).toBeNull();
  });

  it("机器离线时不停靠：没答的审批留在转录里看得见，停靠区是只读带", async () => {
    mockMobileViewport();
    stubDock({ online: false });
    const frames = [{ kind: "user_message", text: "装个依赖" }, permission].map(
      (event, i) => ({
        seq: i + 1,
        method: "runtime.event",
        params: { conversationId: CID, event },
      }),
    );
    const base = mockedApi.getMockImplementation()!;
    mockedApi.mockImplementation(async (path, ...rest) => {
      if (
        typeof path === "string" &&
        path.startsWith("/v1/agent-sessions/transcript")
      )
        return { frames, cursor: 2, has_more: false };
      return base(path, ...rest);
    });
    renderPage();

    expect(await screen.findByTestId("tool-permission-card")).toBeTruthy();
    expect(screen.queryByTestId("tool-permission-dock")).toBeNull();
    expect(screen.getByTestId("session-compose-readonly")).toBeTruthy();
  });

  it("往回翻、下面压着没答的提问：药丸只写「↓ 1 项待处理」，浮在停靠区上方", async () => {
    mockMobileViewport();
    stubDock();
    renderPage();
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    emit([
      { kind: "user_message", text: "第一问" },
      { kind: "text_delta", text: "第一答" },
      { kind: "user_message", text: "选个库" },
      {
        kind: "ask_user_question",
        requestId: "aq-1",
        questions: [
          {
            id: "q1",
            question: "Which database?",
            header: "Storage",
            multiSelect: false,
            options: [{ label: "Postgres" }, { label: "Redis" }],
          },
        ],
      },
    ]);
    await screen.findByText("Which database?");

    // jsdom 没有布局：钉上滚动几何，让视口下沿落在第一轮回复之后。
    const scroll = screen.getByTestId("session-detail-scroll");
    Object.defineProperty(scroll, "clientHeight", { get: () => 480 });
    Object.defineProperty(scroll, "scrollHeight", { get: () => 4_000 });
    scroll.getBoundingClientRect = () => ({ bottom: 200 }) as DOMRect;
    scroll
      .querySelectorAll<HTMLElement>("[data-message-id]")
      .forEach((row, i) => {
        row.getBoundingClientRect = () => ({ top: i * 100 }) as DOMRect;
      });
    // 先在底部落定一次，随后那一下才读得出是「往回滚」。
    act(() => {
      scroll.scrollTop = 3_520;
      fireEvent.scroll(scroll);
    });
    act(() => {
      fireEvent.wheel(scroll, { deltaY: -600 });
      scroll.scrollTop = 1_000;
      fireEvent.scroll(scroll);
    });

    expect(screen.getByTestId("transcript-jump-pending").textContent).toBe(
      "1 pending",
    );
    // 规格「↓ N 项待处理」：有待处理时药丸只说这一句，不再并写「回到底部」/轮数。
    expect(screen.getByTestId("transcript-jump-control").textContent).toBe(
      "1 pending",
    );
    // 药丸在滚动带里（sticky 贴底），停靠区在它下面：不压住输入框。
    expect(scroll.contains(screen.getByTestId("transcript-jump-control"))).toBe(
      true,
    );
    expect(
      screen
        .getByTestId("session-composer-band")
        .contains(screen.getByTestId("transcript-jump-control")),
    ).toBe(false);
  });

  it("停靠区是 dvh 高整页里那一列的最后一个孩子：转录那一带伸缩，停靠区垫底", async () => {
    mockMobileViewport();
    stubDock();
    renderPage();

    const band = await screen.findByTestId("session-composer-band");
    const column = band.parentElement as HTMLElement;
    expect(column.lastElementChild).toBe(band);
    expect(column.className).toMatch(/(^|\s)flex-col(\s|$)/);
    expect(screen.getByTestId("session-detail-scroll").className).toMatch(
      /(^|\s)flex-1(\s|$)/,
    );
    expect(band.className).toMatch(/(^|\s)shrink-0(\s|$)/);
  });
});

/** 认机器的那一段（ResolvedSessionDetail）：加载中 / 找不到 / 读不到 同样一层。 */
describe("移动端会话详情：轮末插话放回", () => {
  function stubSteer() {
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
      if (method === rpcMethods.sessionList)
        return { sessions: [{ ...summary, lifecycleState: "running" }] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeSteer)
        return { queuedId: "q-1", cancellable: true };
      if (method === rpcMethods.runtimeDrainPending) return { steers: [] };
      if (method === rpcMethods.runtimeSubmitToolPermission) return {};
      throw new Error("unexpected: " + method);
    });
  }

  function editorEl(): HTMLElement & {
    editor?: { commands: { setContent: (h: string) => void } };
  } {
    return screen
      .getByTestId("session-composer-band")
      .querySelector(".ProseMirror") as never;
  }

  function paragraphs(): string[] {
    return Array.from(editorEl().querySelectorAll("p")).map(
      (p) => p.textContent ?? "",
    );
  }

  async function steerAndEndTurn(
    text: string,
    draftBeforeEnd?: string,
    beforeEnd?: () => Promise<void>,
  ) {
    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    act(() => editorEl().editor?.commands.setContent(`<p>${text}</p>`));
    fireEvent.click(await screen.findByTestId("session-detail-send"));
    await screen.findByText(text);
    if (draftBeforeEnd) {
      act(() =>
        editorEl().editor?.commands.setContent(`<p>${draftBeforeEnd}</p>`),
      );
    }
    await beforeEnd?.();
    act(() => pageOpts.onRunResultDone?.({} as never));
  }

  const NOTICE = "1 steer(s) not delivered, put back in the input";

  it("轮末没送到：自动接进输入框，一行说明，不再有「恢复为草稿」横幅", async () => {
    mockMobileViewport();
    stubSteer();
    renderPage();
    await steerAndEndTurn("先别动数据库");

    expect(await screen.findByText(NOTICE)).toBeTruthy();
    await waitFor(() => expect(paragraphs()).toEqual(["先别动数据库"]));
    expect(
      screen.queryByRole("button", { name: "Restore as draft" }),
    ).toBeNull();
  });

  it("输入框已有草稿：空行分隔接在后面；「清掉」只移除这一段并收起说明", async () => {
    mockMobileViewport();
    stubSteer();
    renderPage();
    await steerAndEndTurn("先别动数据库", "还没写完");
    await screen.findByText(NOTICE);
    await waitFor(() =>
      expect(paragraphs()).toEqual(["还没写完", "", "先别动数据库"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    expect(paragraphs()).toEqual(["还没写完"]);
  });

  it("排队的插话 chip 用触屏档：撤回键 44px 命中区", async () => {
    mockMobileViewport();
    stubSteer();
    renderPage();
    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    act(() => editorEl().editor?.commands.setContent("<p>先别动数据库</p>"));
    fireEvent.click(await screen.findByTestId("session-detail-send"));

    const withdraw = await screen.findByRole("button", {
      name: "Move back to input",
    });
    expect(withdraw.className).toContain("size-11");
  });

  it("输入框被审批停靠占着时轮末没送到：不丢，也不说「已放回」，输入框回来后才放回并出说明", async () => {
    mockMobileViewport();
    stubSteer();
    renderPage();
    await steerAndEndTurn("先别动数据库", undefined, async () => {
      await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
      act(() =>
        pageOpts.onEvent?.({
          conversationId: CID,
          seq: 1,
          event: {
            kind: "tool_permission_request",
            requestId: "tp-1",
            toolName: "Bash",
            input: { command: "ls" },
          },
        } as never),
      );
      await screen.findByTestId("tool-permission-dock");
    });

    // 执行端的信箱问完了、没送到的那几条已经落进 dropped，输入框还被停靠占着。
    await waitFor(() =>
      expect(
        fakeClient.request.mock.calls.some(
          (c) => c[0] === rpcMethods.runtimeDrainPending,
        ),
      ).toBe(true),
    );
    await act(async () => {});
    // 停靠占着输入框：没有输入框可放，说明不能谎称「已放回」。
    expect(screen.queryByText(NOTICE)).toBeNull();
    act(() =>
      pageOpts.onEvent?.({
        conversationId: CID,
        seq: 2,
        event: {
          kind: "tool_permission_resolved",
          requestId: "tp-1",
          allowed: true,
        },
      } as never),
    );

    expect(await screen.findByText(NOTICE)).toBeTruthy();
    await waitFor(() => expect(paragraphs()).toEqual(["先别动数据库"]));
  });

  it("已放回之后审批停靠把输入框占走、又还回来：那段字重新放回，改动后说明照样收起", async () => {
    mockMobileViewport();
    stubSteer();
    renderPage();
    await steerAndEndTurn("先别动数据库");
    await screen.findByText(NOTICE);
    await waitFor(() => expect(paragraphs()).toEqual(["先别动数据库"]));

    // 审批停靠占住输入框那一位：输入框整个卸下，放回去的那段字跟着没了。
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    act(() =>
      pageOpts.onEvent?.({
        conversationId: CID,
        seq: 1,
        event: {
          kind: "tool_permission_request",
          requestId: "tp-1",
          toolName: "Bash",
          input: { command: "ls" },
        },
      } as never),
    );
    await screen.findByTestId("tool-permission-dock");
    act(() =>
      pageOpts.onEvent?.({
        conversationId: CID,
        seq: 2,
        event: {
          kind: "tool_permission_resolved",
          requestId: "tp-1",
          allowed: true,
        },
      } as never),
    );

    // 说明还挂着「已放回」，输入框里就必须真有那段字。
    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    await waitFor(() => expect(paragraphs()).toEqual(["先别动数据库"]));

    act(() => editorEl().editor?.commands.setContent("<p>先别动数据库啊</p>"));
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
  });

  it("输入框被停靠占着时换了会话：那几条不会放进另一条会话的输入框", async () => {
    mockMobileViewport();
    stubSteer();
    const view = renderPage();
    await steerAndEndTurn("先别动数据库", undefined, async () => {
      await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
      act(() =>
        pageOpts.onEvent?.({
          conversationId: CID,
          seq: 1,
          event: {
            kind: "tool_permission_request",
            requestId: "tp-1",
            toolName: "Bash",
            input: { command: "ls" },
          },
        } as never),
      );
      await screen.findByTestId("tool-permission-dock");
    });
    await waitFor(() =>
      expect(
        fakeClient.request.mock.calls.some(
          (c) => c[0] === rpcMethods.runtimeDrainPending,
        ),
      ).toBe(true),
    );
    await act(async () => {});

    const other = "22222222-2222-7222-8222-222222222222";
    view.rerender(
      <MemoryRouter initialEntries={[`/chat/${other}`]}>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId={other} form="page" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(paragraphs().join("")).toBe("");
  });

  it("改动输入框后说明消失，不再有「清掉」", async () => {
    mockMobileViewport();
    stubSteer();
    renderPage();
    await steerAndEndTurn("先别动数据库");
    await screen.findByText(NOTICE);

    act(() => editorEl().editor?.commands.setContent("<p>先别动数据库啊</p>"));

    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(paragraphs()).toEqual(["先别动数据库啊"]);
  });
});

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
    // 返回行与身份行同在顶带那一层底色里：不是一条内缩的色带。
    const head = screen.getByTestId("session-detail-header");
    expect(head.contains(row)).toBe(true);
    expect(head.className).toMatch(/(^|\s)bg-sheet-header(\s|$)/);
  });
});

/**
 * 会话里打开文件（规格 2026-09-21-server-mobile-gaps「会话中的文件预览（移动端）」、
 * 决策 2 与 4、问题 3）：此前预览是 420 定宽列，390 屏上转录与输入框被挤成 0 宽。
 * 移动端改为整屏一层，占一条 history；返回按钮与系统返回都只关这一层。
 */
describe("移动端会话里的文件预览：整屏一层", () => {
  let capturedOpts: UseRelayChannelOptions = {};
  const probe: { location?: Location; navigate?: NavigateFunction } = {};

  function LocationProbe() {
    probe.location = useLocation();
    probe.navigate = useNavigate();
    return null;
  }

  function stubPreview(opts: { read?: () => Promise<unknown> } = {}) {
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
      if (method === rpcMethods.workspaceFsReadFile)
        return opts.read
          ? opts.read()
          : {
              content: new TextEncoder().encode("文件正文\n"),
              contentType: "",
            };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: CID,
        event: {
          kind: "text_delta",
          text: "改完了，见 [说明](/home/agent/proj/docs/a.md)。",
        },
        seq: 1,
      } as never);
      return {} as never;
    });
  }

  function renderWithLink(entries: InitialEntry[] = [`/chat/${CID}`]) {
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
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
      };
    });
    return render(
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <ThemeProvider>
          <LocationProbe />
          <SessionDetailView deviceId={1} conversationId={CID} form="page" />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  function composerEditable(): HTMLElement & {
    editor?: { commands: { setContent: (v: string) => void } };
  } {
    const el = document.querySelector<HTMLElement>(
      '[data-testid="session-detail-composer"] .ProseMirror',
    );
    if (!el) throw new Error("输入框没渲染出来");
    return el;
  }

  /** markdown 的视图档位分段里，此刻按下的那一格。 */
  function pressedSegment(layer: HTMLElement): string | null {
    const group = within(layer).getByRole("group", {
      name: "View mode",
    });
    return (
      within(group)
        .getAllByRole("button")
        .find((b) => b.getAttribute("aria-pressed") === "true")?.textContent ??
      null
    );
  }

  const marked = () =>
    Boolean(
      (probe.location?.state as Record<string, unknown> | null)?.[
        FILE_PREVIEW_LAYER_STATE_KEY
      ],
    );

  async function openLink() {
    const link = await screen.findByText("说明", undefined, { timeout: 3_000 });
    fireEvent.click(link);
    return screen.findByTestId("session-file-preview-layer", undefined, {
      timeout: 3_000,
    });
  }

  beforeEach(() => {
    capturedOpts = {};
    probe.location = undefined;
    probe.navigate = undefined;
  });

  afterEach(() => {
    fakeClient.catchUp.mockImplementation(async () => ({}) as never);
  });

  it("打开：整屏层盖住会话（头部与输入框），有返回、文件名标题、目录与机器副行和现有面板", async () => {
    mockMobileViewport();
    stubPreview();
    renderWithLink();
    const before = await waitFor(() => {
      expect(probe.location).toBeTruthy();
      return probe.location!;
    });

    const layer = await openLink();

    // 同一地址多了一条带标记的 history。
    expect(probe.location!.pathname).toBe(`/chat/${CID}`);
    expect(probe.location!.key).not.toBe(before.key);
    expect(marked()).toBe(true);
    // 整屏一层，不是 420 定宽列。
    expect(layer.className).toMatch(/fixed/);
    expect(layer.className).toMatch(/inset-0/);
    expect(layer.className).not.toContain("w-[420px]");
    expect(screen.queryByTestId("session-file-preview")).toBeNull();
    expect(
      within(layer).getByRole("button", { name: "Back to conversation" }),
    ).toBeTruthy();
    expect(within(layer).getByRole("heading", { name: "a.md" })).toBeTruthy();
    expect(
      within(layer).getByTestId("session-file-preview-layer-subline")
        .textContent,
    ).toBe("docs · 书房小主机");
    expect(within(layer).getByTestId("file-preview-panel")).toBeTruthy();
    expect(await within(layer).findByText("文件正文")).toBeTruthy();
    // 会话头与输入框都在层下面，不在层里。
    expect(layer.contains(screen.getByTestId("session-detail-identity"))).toBe(
      false,
    );
    expect(layer.contains(screen.getByTestId("session-detail-composer"))).toBe(
      false,
    );
  });

  it("返回按钮：只关这一层，转录与输入框原样还在，再点链接回到这一层", async () => {
    mockMobileViewport();
    stubPreview();
    renderWithLink();
    await screen.findByText("说明", undefined, { timeout: 3_000 });
    await waitFor(() => composerEditable());
    composerEditable().editor?.commands.setContent("<p>还没发的一句</p>");
    const transcript = screen.getByTestId("session-detail-transcript");
    const composerNode = composerEditable();
    const entry = probe.location!.key;

    const layer = await openLink();
    fireEvent.click(
      within(layer).getByRole("button", { name: "Back to conversation" }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("session-file-preview-layer")).toBeNull(),
    );
    expect(probe.location!.key).toBe(entry);
    expect(probe.location!.pathname).toBe(`/chat/${CID}`);
    // 同一个节点：没被卸下重挂，滚动位置与未发送的文字都跟着它。
    expect(screen.getByTestId("session-detail-transcript")).toBe(transcript);
    expect(composerEditable()).toBe(composerNode);
    expect(composerEditable().textContent).toBe("还没发的一句");

    const again = await openLink();
    expect(within(again).getByRole("heading", { name: "a.md" })).toBeTruthy();
  });

  it("系统返回（popstate）：同样只关这一层，标签留着", async () => {
    mockMobileViewport();
    stubPreview();
    renderWithLink();
    await screen.findByText("说明", undefined, { timeout: 3_000 });
    const entry = probe.location!.key;
    const layer = await openLink();
    // 切一格视图档位：档位存在标签上，关层之后它若还在，就证明标签没被清。
    const group = await within(layer).findByRole("group", {
      name: "View mode",
    });
    const other = within(group)
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-pressed") !== "true")!;
    fireEvent.click(other);
    const chosen = other.textContent;
    expect(pressedSegment(layer)).toBe(chosen);

    act(() => {
      void probe.navigate!(-1);
    });

    await waitFor(() =>
      expect(screen.queryByTestId("session-file-preview-layer")).toBeNull(),
    );
    expect(probe.location!.key).toBe(entry);
    expect(screen.getByTestId("session-detail-identity")).toBeTruthy();

    const again = await openLink();
    expect(pressedSegment(again)).toBe(chosen);
  });

  it("关掉最后一个标签：层关掉，并退掉它压的那一条", async () => {
    mockMobileViewport();
    stubPreview();
    renderWithLink();
    await screen.findByText("说明", undefined, { timeout: 3_000 });
    const entry = probe.location!.key;
    const layer = await openLink();

    fireEvent.click(
      within(layer).getByRole("button", { name: "Close preview" }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("session-file-preview-layer")).toBeNull(),
    );
    expect(probe.location!.key).toBe(entry);
    expect(marked()).toBe(false);
  });

  it("重载后遗留的标记、没有标签：视为关着；打开再返回回到会话", async () => {
    mockMobileViewport();
    stubPreview();
    renderWithLink([
      `/chat/${CID}`,
      {
        pathname: `/chat/${CID}`,
        state: { [FILE_PREVIEW_LAYER_STATE_KEY]: true },
      },
    ]);

    await screen.findByText("说明", undefined, { timeout: 3_000 });
    expect(screen.queryByTestId("session-file-preview-layer")).toBeNull();
    expect(screen.queryByTestId("session-file-preview")).toBeNull();

    const layer = await openLink();
    fireEvent.click(
      within(layer).getByRole("button", { name: "Back to conversation" }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("session-file-preview-layer")).toBeNull(),
    );
    expect(probe.location!.pathname).toBe(`/chat/${CID}`);
    expect(marked()).toBe(false);
  });

  it("读不到文件：失败展示在层里，返回照常可用", async () => {
    mockMobileViewport();
    stubPreview({ read: () => Promise.reject(new Error("磁盘读不到")) });
    renderWithLink();
    await screen.findByText("说明", undefined, { timeout: 3_000 });
    const entry = probe.location!.key;

    const layer = await openLink();
    expect(
      await within(layer).findByRole("button", { name: "Retry" }),
    ).toBeTruthy();

    fireEvent.click(
      within(layer).getByRole("button", { name: "Back to conversation" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("session-file-preview-layer")).toBeNull(),
    );
    expect(probe.location!.key).toBe(entry);
  });

  it("桌面：仍是 420 定宽右栏，不压 history", async () => {
    stubPreview();
    renderWithLink();
    await screen.findByText("说明", undefined, { timeout: 3_000 });
    const entry = probe.location!.key;

    fireEvent.click(screen.getByText("说明"));

    const column = await screen.findByTestId("session-file-preview");
    expect(column.className).toContain("w-[420px]");
    expect(screen.queryByTestId("session-file-preview-layer")).toBeNull();
    expect(probe.location!.key).toBe(entry);
    expect(marked()).toBe(false);
  });
});
