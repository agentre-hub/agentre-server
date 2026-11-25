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
import SessionModelControl from "@/components/session/SessionModelControl";
import ResolvedSessionDetail from "@/components/session/ResolvedSessionDetail";
import { FILE_PREVIEW_LAYER_STATE_KEY } from "@/components/session/useFilePreviewTabs";
import { toTranscriptFrame } from "@/components/session/transcriptFrame";
import { bindAccount } from "@/lib/localStore";
import { RelayError } from "@/lib/relayClient";
import { transcriptCache } from "@/lib/transcriptCache";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

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

  it("一行里：返回 · 标题（一行）· ⋯；副标题「● 状态 · Agent」，机器名在 ••• 里", async () => {
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
    // 手机页头统一 52px（2026-11-20 第 14 项）；返回是 ‹ 不是 ←。
    // 底色与 iOS 主屏幕 App 的白状态栏、转录区同一个白（--sheet）：灰的 sheet-header
    // 夹在白状态栏与白转录之间是一条断开的色带。不画分隔线（无边框规则），正文滚到
    // 页头底下时由滚动带上沿的渐隐淡掉。
    expect(head.className).toMatch(/(^|\s)h-\[52px\](\s|$)/);
    expect(head.className).toMatch(/(^|\s)bg-sheet(\s|$)/);
    expect(head.className).not.toMatch(/(^|\s)border-b(\s|$)/);
    expect(screen.getByTestId("session-detail-scroll").className).toContain(
      "transcript-fade-top",
    );
    expect(head.className).not.toMatch(/bg-sheet-header/);
    expect(band.className).toMatch(/(^|\s)h-\[52px\](\s|$)/);
    expect(band.className).toMatch(/(^|\s)bg-sheet(\s|$)/);
    expect(band.className).not.toMatch(/bg-sheet-header/);
    expect(
      within(band)
        .getByRole("link", { name: "Back" })
        .querySelector("svg.lucide-chevron-left"),
    ).not.toBeNull();
    expect(
      within(band).getByRole("button", { name: "More actions" }),
    ).toBeTruthy();

    const meta = within(band).getByTestId("session-detail-meta");
    expect(
      [...meta.querySelectorAll("[data-testid^='session-detail-meta-']")].map(
        (el) => el.getAttribute("data-testid"),
      ),
    ).toEqual(["session-detail-meta-status", "session-detail-meta-agent"]);
    expect(
      within(meta).getByTestId("session-detail-meta-status").textContent,
    ).toContain("Idle");
    expect(
      (await within(meta).findByTestId("session-detail-meta-agent"))
        .textContent,
    ).toContain("后端 Agent");
    // 窄屏截断而不收起：两段都留在 DOM 里、读屏读得到。
    for (const part of meta.querySelectorAll("[data-part]")) {
      expect(part.className).not.toMatch(/hidden/);
    }
    // 机器名不进副行：三段按比例一起收缩时最长的机器名留得最多，状态与 Agent 名
    // 反被截成「空..」「Claude ...」。机器名在 ••• 的信息面板里。
    expect(meta.textContent).not.toContain("书房小主机");
    fireEvent.click(within(band).getByRole("button", { name: "More actions" }));
    expect(await screen.findByText("书房小主机")).toBeTruthy();
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

  // 规格 2026-11-25 H5：页头只写「离线」，「N 分钟前」是对话最后活动、与机器最后在线对不上。
  it("机器离线时状态字只写「Offline」，不带时间", async () => {
    mockMobileViewport();
    stubWithIdentity({ online: false });
    renderPage();

    const status = await screen.findByTestId("session-detail-meta-status");
    await waitFor(() => expect(status.textContent).toBe("Offline"));
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
    expect(row.className).toMatch(/(^|\s)h-\[52px\](\s|$)/);
    expect(row.className).toMatch(/(^|\s)bg-sheet(\s|$)/);
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

  it("审批：连接未就绪时三键禁用、上方写「正在连接」；连上的那条没有", async () => {
    mockMobileViewport();
    stubDock({ lifecycleState: "running" });
    renderPage({ relayState: "reconnecting" });
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    emit([{ kind: "user_message", text: "装个依赖" }, permission]);

    const dock = await screen.findByTestId("tool-permission-dock");
    expect(
      within(dock).getByTestId("tool-permission-dock-connecting"),
    ).toBeTruthy();
    for (const name of ["Allow", "Always Allow This Session", "Reject"]) {
      expect(
        (within(dock).getByRole("button", { name }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
  });

  it("审批：连上之后没有「正在连接」，三键可点", async () => {
    mockMobileViewport();
    stubDock({ lifecycleState: "running" });
    renderPage({ relayState: "connected" });
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    emit([{ kind: "user_message", text: "装个依赖" }, permission]);

    const dock = await screen.findByTestId("tool-permission-dock");
    expect(
      within(dock).queryByTestId("tool-permission-dock-connecting"),
    ).toBeNull();
    expect(
      (within(dock).getByRole("button", { name: "Allow" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("审批：提交超时写「没收到确认，可能已经生效」并给重试，重试再发一次", async () => {
    mockMobileViewport();
    stubDock({ lifecycleState: "running" });
    const base = fakeClient.request.getMockImplementation()!;
    let submits = 0;
    fakeClient.request.mockImplementation(async (method: unknown, ...rest) => {
      if (method === rpcMethods.runtimeSubmitToolPermission) {
        submits += 1;
        if (submits === 1) throw new RelayError(-1, "relay: 请求超时", null);
        return {};
      }
      return (base as (...a: unknown[]) => unknown)(method, ...rest);
    });
    renderPage();
    await screen.findByTestId("session-detail-identity");
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());
    emit([{ kind: "user_message", text: "装个依赖" }, permission]);

    const dock = await screen.findByTestId("tool-permission-dock");
    fireEvent.click(within(dock).getByRole("button", { name: "Allow" }));
    expect(
      await within(dock).findByText(
        "No confirmation received. It may already have taken effect",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dock).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(submits).toBe(2));
  });

  it("提问卡用触屏档：标题「Agent is asking you」；连上时可作答，掉线后提交禁用并说明", async () => {
    mockMobileViewport();
    stubDock({ lifecycleState: "running" });
    const view = renderPage({ relayState: "connected" });
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
    expect(await screen.findByText("Agent is asking you")).toBeTruthy();
    expect(screen.queryByTestId("user-ask-connecting")).toBeNull();

    // 连接掉了：同一张卡，提交 / 跳过禁用，卡上说明。
    const impl = mockUseRelay.getMockImplementation()!;
    mockUseRelay.mockImplementation(
      (fp, o) => ({ ...impl(fp, o), relayState: "reconnecting" }) as never,
    );
    view.rerender(
      <MemoryRouter initialEntries={[`/chat/${CID}`]}>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId={CID} form="page" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("user-ask-connecting")).toBeTruthy();
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
      if (method === rpcMethods.runtimeAbort) return {};
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

  const NOTICE = "1 steer not delivered, put back in the input";

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

  // dev 实机（390px，63ed07c6）复现的那一串：插话排着时点停止。agentred 报「取走了」
  // 只走**预览帧**（fanout 一律 Preview: true；持久那一份是转录里的一行 user_message，
  // 不是 steer_consumed），随后是这一轮的终态。那句话已经作为一行用户消息进了转录，
  // 就不能再放回输入框——同一句话两边都出现，用户会把它再发一遍。
  it("插话被取走后点停止：已进转录的那句不再放回输入框，也没有「已放回」说明", async () => {
    mockMobileViewport();
    stubSteer();
    renderPage();
    const text = "补充：数完之后说一句完成";
    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    act(() => editorEl().editor?.commands.setContent(`<p>${text}</p>`));
    fireEvent.click(await screen.findByTestId("session-detail-send"));
    await screen.findByText("Queued · 1");

    fireEvent.click(
      within(screen.getByTestId("session-composer-band")).getByRole("button", {
        name: "Stop",
      }),
    );
    await waitFor(() =>
      expect(
        fakeClient.request.mock.calls.some(
          (c) => c[0] === rpcMethods.runtimeAbort,
        ),
      ).toBe(true),
    );

    // daemon 的 Abort 先把信箱清走（报成「取走了」，只有预览帧），转录里落一行用户
    // 消息，然后才是被叫停的这一轮的终态。
    act(() => {
      pageOpts.onPreviewEvent?.(
        {
          conversationId: CID,
          event: {
            kind: "steer_consumed",
            steers: [{ queuedId: "q-1", text }],
          },
        } as never,
        0,
      );
      pageOpts.onEvent?.(
        {
          conversationId: CID,
          event: { kind: "user_message", text },
          seq: 1,
        } as never,
        0,
      );
    });
    act(() =>
      pageOpts.onRunResultDone?.({
        conversationId: CID,
        stopErrMsg: "interrupted",
      } as never),
    );

    await waitFor(() => expect(screen.queryByText(/^Queued · /)).toBeNull());
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(paragraphs().join("")).toBe("");
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

/*
  弱网规格 2026-11-20 决策 13：手机上真用户消息排在右侧（#38），「发送中」与「排队」
  那两条跟它同一列 —— 区别只在边与小字，不在位置。
*/
describe("移动端会话详情：还不是正式消息的那两条与真消息同列", () => {
  function stubSend(onRun: () => unknown) {
    stubApi();
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return onRun();
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

  async function send(text: string) {
    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    act(() => editorEl().editor?.commands.setContent(`<p>${text}</p>`));
    fireEvent.click(await screen.findByTestId("session-detail-send"));
  }

  it("发送中那一条：右对齐，在转录里", async () => {
    mockMobileViewport();
    stubSend(() => new Promise(() => {}));
    renderPage();
    await screen.findByText(/重构登录页/);
    await send("先看看日志");

    const bubble = await screen.findByTestId("send-sending");
    expect(bubble.getAttribute("data-align")).toBe("end");
    expect(
      bubble.closest('[data-testid="session-detail-transcript"]'),
    ).toBeTruthy();
  });

  it("重连期间排着的那一条：右对齐，「撤销」还在", async () => {
    mockMobileViewport();
    stubSend(() => ({}));
    renderPage({ relayState: "reconnecting" });
    await send("连上再发");

    const queued = await screen.findByTestId("send-pending");
    expect(queued.getAttribute("data-align")).toBe("end");
    expect(within(queued).getByTestId("send-pending-cancel")).toBeTruthy();
  });
});

/**
 * 最近打开的对话从本地立即显示（规格 2026-11-25 决策 A1 对话部分、A5、d9 审批）：
 *   - 本地那一页先画出来，页头状态置灰「同步中」，新的到了按序号合并、不重复不跳号；
 *   - 补齐的游标接在真正画到的那一格之后（镜像读到了按镜像，读不到按本地那一页）；
 *   - 本地停在待审批卡上：停靠条置灰「正在确认是否还在等你」，确认仍在等才可点，
 *     不再等就收起；连不上（离线打开）一直置灰；
 *   - 别处删掉了这条对话：本地那一页撤掉、缓存一并丢掉。
 */
describe("移动端会话详情：本地先画（A1、A5、d9）", () => {
  const g = globalThis as Record<string, unknown>;

  beforeEach(() => {
    g.indexedDB = new IDBFactory();
    g.IDBKeyRange = IDBKeyRange;
    bindAccount(1);
  });

  afterEach(() => {
    bindAccount(null);
    delete g.indexedDB;
    delete g.IDBKeyRange;
  });

  const row = {
    conversation_id: CID,
    peer_fingerprint: "fp-1",
    device_fingerprint: "fp-1",
    title: "重构登录页",
    agent_sync_id: "ag-1",
    lifecycle_state: "idle",
  };

  type Ev = Record<string, unknown>;
  const said = (text: string): Ev => ({ kind: "user_message", text });
  const permission: Ev = {
    kind: "tool_permission_request",
    requestId: "tp-1",
    toolName: "Bash",
    input: { command: "pnpm add left-pad" },
  };

  async function seedCache(events: [number, Ev][], lastSeq?: number) {
    await transcriptCache.open(
      CID,
      {
        events: events.map(([seq, event]) =>
          toTranscriptFrame({ conversationId: CID, seq, event } as never, 0),
        ),
        lastSeq: lastSeq ?? events.at(-1)![0],
        oldestSeq: events[0][0],
        hasBefore: false,
        row: row as never,
      },
      1000,
    );
  }

  function mirrorPage(events: [number, Ev][], cursor?: number) {
    return {
      frames: events.map(([seq, event]) => ({
        seq,
        method: "runtime.event",
        params: { conversationId: CID, event },
      })),
      cursor: cursor ?? events.at(-1)?.[0] ?? 0,
      oldest_seq: events[0]?.[0] ?? 0,
      has_before: false,
    };
  }

  function stubLocal(opts: {
    transcript: () => Promise<unknown>;
    rowItems?: unknown[];
    devices?: () => Promise<unknown>;
    waiters?: () => Promise<unknown>;
    latestSeq?: number;
  }) {
    mockedApi.mockImplementation(async (path) => {
      const p = String(path);
      if (p === "/v1/devices")
        return opts.devices ? opts.devices() : { devices: [deviceRow] };
      if (p.startsWith("/v1/agent-sessions/transcript"))
        return opts.transcript();
      if (p.startsWith("/v1/agent-sessions?"))
        return { items: opts.rowItems ?? [row] };
      if (p === "/v1/agent-sessions/read") return { last_read_at: 1 };
      return new Promise(() => {});
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [{ ...summary, latestSeq: opts.latestSeq ?? 0 }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return opts.waiters
          ? opts.waiters()
          : { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeSubmitToolPermission) return {};
      return new Promise(() => {});
    });
  }

  const hang = () => new Promise(() => {});

  /** 被 fieldset 禁用的按钮 `.disabled` 仍是 false，按 :disabled 判。 */
  const isDisabled = (el: HTMLElement) => el.matches(":disabled");

  /** 镜像那一页由用例决定什么时候回来：先让本机那一页画出来。 */
  function deferred() {
    let answer!: (v: unknown) => void;
    const promise = new Promise((r) => (answer = r));
    return { promise, answer: (v: unknown) => answer(v) };
  }

  it("网络还没回来：本地那一页立即出现，页头状态置灰写「同步中」", async () => {
    mockMobileViewport();
    await seedCache([[1, said("缓存里的那句")]]);
    stubLocal({ transcript: hang, devices: hang });
    renderPage({ relayState: "connecting" });

    expect(await screen.findByText("缓存里的那句")).toBeTruthy();
    expect(screen.getByText("重构登录页")).toBeTruthy();
    const status = screen.getByTestId("session-detail-status");
    expect(status.textContent).toBe("Syncing");
    expect(status.getAttribute("data-syncing")).toBe("true");
  });

  it("新的一页到了：按序号合并，不重复；补齐游标接在镜像那一页的末尾", async () => {
    mockMobileViewport();
    await seedCache([
      [1, said("一")],
      [2, said("二")],
      [3, said("三")],
    ]);
    let answer!: (v: unknown) => void;
    stubLocal({
      transcript: () => new Promise((r) => (answer = r)),
      latestSeq: 4,
    });
    renderPage();
    expect(await screen.findByText("三")).toBeTruthy();

    await act(async () =>
      answer(
        mirrorPage([
          [2, said("二")],
          [3, said("三")],
          [4, said("四")],
        ]),
      ),
    );
    expect(await screen.findByText("四")).toBeTruthy();
    for (const text of ["二", "三", "四"]) {
      expect(screen.getAllByText(text)).toHaveLength(1);
    }
    await waitFor(() =>
      expect(fakeClient.setCursor).toHaveBeenCalledWith(CID, 4, undefined),
    );
    await waitFor(() =>
      expect(screen.getByTestId("session-detail-status").textContent).not.toBe(
        "Syncing",
      ),
    );
  });

  it("本地比镜像新：多出来的那几帧留着，补齐从镜像末尾接，重放的那一帧不重复", async () => {
    mockMobileViewport();
    await seedCache([
      [1, said("一")],
      [2, said("二")],
      [3, said("三")],
      [4, said("四")],
    ]);
    const mirror = deferred();
    stubLocal({ transcript: () => mirror.promise, latestSeq: 4 });
    renderPage();
    expect(await screen.findByText("四")).toBeTruthy();

    await act(async () =>
      mirror.answer(
        mirrorPage([
          [1, said("一")],
          [2, said("二")],
          [3, said("三")],
        ]),
      ),
    );
    await waitFor(() =>
      expect(fakeClient.setCursor).toHaveBeenCalledWith(CID, 3, undefined),
    );
    expect(screen.getAllByText("四")).toHaveLength(1);
    // 补齐把第 4 帧再送一遍：同一号只画一次。
    act(() => {
      pageOpts.onEvent?.({
        conversationId: CID,
        event: said("四"),
        seq: 4,
      } as never);
    });
    expect(screen.getAllByText("四")).toHaveLength(1);
  });

  it("镜像读不到（离线后恢复中继）：补齐从本地那一页的末尾接，不跳号", async () => {
    mockMobileViewport();
    await seedCache([
      [6, said("六")],
      [7, said("七")],
    ]);
    stubLocal({
      transcript: async () => {
        throw new TypeError("Failed to fetch");
      },
      latestSeq: 900,
    });
    renderPage();

    expect(await screen.findByText("七")).toBeTruthy();
    await waitFor(() =>
      expect(fakeClient.setCursor).toHaveBeenCalledWith(CID, 7, undefined),
    );
    // 没有退回「只补最后 400 帧」的那一档：那会在 7 与 500 之间留一个洞。
    expect(fakeClient.setCursor).not.toHaveBeenCalledWith(
      CID,
      900 - 400,
      undefined,
    );
    expect(screen.queryByTestId("session-history-unavailable")).toBeNull();
  });

  it("离线打开、本地停在待审批卡上：停靠条置灰写「正在确认是否还在等你」，一直点不动", async () => {
    mockMobileViewport();
    await seedCache([
      [1, said("装个依赖")],
      [2, permission],
    ]);
    stubLocal({
      transcript: async () => {
        throw new TypeError("Failed to fetch");
      },
      devices: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderPage({ relayState: "connecting" });

    const dock = await screen.findByTestId("tool-permission-dock");
    expect(
      within(dock).getByTestId("tool-permission-dock-confirming").textContent,
    ).toBe("Checking whether it's still waiting for you");
    const allow = within(dock).getByRole("button", { name: "Allow" });
    expect(isDisabled(allow)).toBe(true);
    expect(
      isDisabled(within(dock).getByRole("button", { name: "Reject" })),
    ).toBe(true);
    // 一直连不上：一直置灰，那句话一直在。（点不动靠浏览器对 :disabled 的处理，
    // jsdom 的 fireEvent 不经过它，所以这里只认 :disabled。）
    await new Promise((r) => setTimeout(r, 100));
    expect(isDisabled(allow)).toBe(true);
    expect(screen.getByTestId("tool-permission-dock-confirming")).toBeTruthy();
    expect(
      fakeClient.request.mock.calls.some(
        (c) => c[0] === rpcMethods.sessionPendingWaiters,
      ),
    ).toBe(false);
  });

  it("确认仍在等：停靠条变成可点，那句话撤掉", async () => {
    mockMobileViewport();
    await seedCache([
      [1, said("装个依赖")],
      [2, permission],
    ]);
    let answer!: (v: unknown) => void;
    const mirror = deferred();
    stubLocal({
      transcript: () => mirror.promise,
      latestSeq: 2,
      waiters: () => new Promise((r) => (answer = r)),
    });
    renderPage();

    const dock = await screen.findByTestId("tool-permission-dock");
    expect(
      isDisabled(within(dock).getByRole("button", { name: "Allow" })),
    ).toBe(true);
    await act(async () =>
      mirror.answer(
        mirrorPage([
          [1, said("装个依赖")],
          [2, permission],
        ]),
      ),
    );
    // 镜像那一页到了也还不算：要问过那台机器。
    expect(
      isDisabled(
        within(screen.getByTestId("tool-permission-dock")).getByRole("button", {
          name: "Allow",
        }),
      ),
    ).toBe(true);
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    await act(async () =>
      answer({
        toolPermissions: [{ RequestID: "tp-1", ToolName: "Bash" }],
        askUserQuestions: [],
      }),
    );
    await waitFor(() =>
      expect(
        isDisabled(
          within(screen.getByTestId("tool-permission-dock")).getByRole(
            "button",
            { name: "Allow" },
          ),
        ),
      ).toBe(false),
    );
    expect(screen.queryByTestId("tool-permission-dock-confirming")).toBeNull();
  });

  it("不再等了（别处已经答过）：停靠条收起，输入框回来，转录里也不留一张能点的卡", async () => {
    mockMobileViewport();
    await seedCache([
      [1, said("装个依赖")],
      [2, permission],
    ]);
    const mirror = deferred();
    stubLocal({ transcript: () => mirror.promise, latestSeq: 2 });
    renderPage();

    await screen.findByTestId("tool-permission-dock");
    await act(async () =>
      mirror.answer(
        mirrorPage([
          [1, said("装个依赖")],
          [2, permission],
        ]),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("tool-permission-dock")).toBeNull(),
    );
    const band = screen.getByTestId("session-composer-band");
    await waitFor(() =>
      expect(band.querySelector(".ProseMirror")).toBeTruthy(),
    );
    expect(screen.queryByTestId("tool-permission-card")).toBeNull();
  });

  it("没在本地的对话照旧：不说「同步中」，新开的那一页存进本地", async () => {
    mockMobileViewport();
    stubLocal({
      transcript: async () => mirrorPage([[5, said("五")]]),
      latestSeq: 5,
    });
    renderPage();

    expect(await screen.findByText("五")).toBeTruthy();
    expect(screen.getByTestId("session-detail-status").textContent).not.toBe(
      "Syncing",
    );
    await waitFor(async () => {
      const got = await transcriptCache.get(CID);
      expect(got?.lastSeq).toBe(5);
      expect(got?.events.map((f) => f.seq)).toEqual([5]);
      expect(got?.row?.title).toBe("重构登录页");
    });
  });

  it("存回本机的只有最近一页：看着它时实时到的帧把最老的挤出去，页长同首屏那一页", async () => {
    mockMobileViewport();
    stubLocal({
      transcript: async () =>
        mirrorPage([
          [1, said("一")],
          [2, said("二")],
        ]),
      latestSeq: 2,
    });
    renderPage();
    expect(await screen.findByText("二")).toBeTruthy();
    await waitFor(() => expect(pageOpts.onEvent).toBeTruthy());

    act(() => {
      for (const [seq, text] of [
        [3, "三"],
        [4, "四"],
        [5, "五"],
      ] as const) {
        pageOpts.onEvent?.({
          conversationId: CID,
          event: said(text),
          seq,
        } as never);
      }
    });
    expect(await screen.findByText("五")).toBeTruthy();

    await waitFor(async () => {
      const got = await transcriptCache.get(CID);
      expect(got?.events.map((f) => f.seq)).toEqual([4, 5]);
      expect(got?.oldestSeq).toBe(4);
      expect(got?.hasBefore).toBe(true);
      expect(got?.lastSeq).toBe(5);
    });
  });

  it("别处删掉了这条对话：本地那一页撤掉，缓存一并丢掉", async () => {
    mockMobileViewport();
    await seedCache([[1, said("已经删掉的那句")]]);
    let answer!: (v: unknown) => void;
    stubLocal({
      transcript: () => new Promise((r) => (answer = r)),
      rowItems: [],
    });
    renderPage();
    expect(await screen.findByText("已经删掉的那句")).toBeTruthy();

    await act(async () => answer(mirrorPage([])));
    await waitFor(() =>
      expect(screen.queryByText("已经删掉的那句")).toBeNull(),
    );
    await waitFor(async () =>
      expect(await transcriptCache.get(CID)).toBeUndefined(),
    );
  });

  it("桌面嵌入形态同样先画本地那一页（不加新样子）", async () => {
    await seedCache([[1, said("桌面上的缓存")]]);
    stubLocal({ transcript: hang, devices: hang });
    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState: "connecting",
      relayTicket: null,
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
    expect(await screen.findByText("桌面上的缓存")).toBeTruthy();
    expect(screen.queryByText("Syncing")).toBeNull();
  });
});

/**
 * 手机上的输入框与模型选择（规格 H2、H4）：模型选择是底部 sheet、打开不聚焦搜索框、
 * 系统返回先关它；工具条上模型以短名代替人形图标；键盘升起时输入框最高约可视高度的 1/3。
 * 桌面一律不变。
 */
describe("移动端：模型选择 sheet 与输入框（H2、H4）", () => {
  const catalog = [
    {
      providerKey: "k-anthropic",
      id: 1,
      name: "Anthropic",
      type: "anthropic",
      enabled: true,
      defaultModel: {
        modelKey: "mk-1",
        modelId: "claude-sonnet-4-6",
        enabled: true,
      },
      models: [
        { modelKey: "mk-1", modelId: "claude-sonnet-4-6", enabled: true },
      ],
    },
  ];

  function Probe() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <div>
        <span data-testid="probe-path">{location.pathname}</span>
        <button onClick={() => navigate(-1)}>system-back</button>
      </div>
    );
  }

  function renderControl(target = { providerKey: "", modelKey: "" }) {
    return render(
      <MemoryRouter initialEntries={["/prev", "/chat/x"]} initialIndex={1}>
        <ThemeProvider>
          <Probe />
          <SessionModelControl
            backendType="claudecode"
            catalog={catalog}
            boundProviderKey="k-anthropic"
            boundModelKey="mk-1"
            target={target}
            onChange={() => {}}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("手机：点模型 pill 开底部 sheet，搜索框不聚焦", async () => {
    mockMobileViewport();
    renderControl();
    fireEvent.click(screen.getByTestId("composer-model-target"));
    const sheet = await screen.findByTestId("model-target-sheet");
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).not.toBe(
      within(sheet).getByPlaceholderText("Search providers or models…"),
    );
  });

  it("手机：系统返回先关 sheet，停在原页", async () => {
    mockMobileViewport();
    renderControl();
    fireEvent.click(screen.getByTestId("composer-model-target"));
    await screen.findByTestId("model-target-sheet");
    fireEvent.click(screen.getByText("system-back"));
    await waitFor(() =>
      expect(screen.queryByTestId("model-target-sheet")).toBeNull(),
    );
    expect(screen.getByTestId("probe-path").textContent).toBe("/chat/x");
  });

  it("桌面：仍是浮层，不是 sheet", async () => {
    renderControl();
    fireEvent.click(screen.getByTestId("composer-model-target"));
    await screen.findByTestId("model-target-popover");
    expect(screen.queryByTestId("model-target-sheet")).toBeNull();
  });

  it("手机：钉了模型时 pill 脸上是模型短名；桌面不画短名", () => {
    mockMobileViewport();
    const { unmount } = renderControl({
      providerKey: "k-anthropic",
      modelKey: "mk-1",
    });
    expect(screen.getByTestId("provider-pill-short-name").textContent).toBe(
      "Sonnet",
    );
    unmount();
    window.matchMedia = originalMatchMedia;
    renderControl({ providerKey: "k-anthropic", modelKey: "mk-1" });
    expect(screen.queryByTestId("provider-pill-short-name")).toBeNull();
  });

  describe("键盘升起时限高", () => {
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    function setKeyboard(height: number | null) {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value:
          height === null
            ? undefined
            : {
                height,
                offsetTop: 0,
                scale: 1,
                addEventListener: () => {},
                removeEventListener: () => {},
              },
      });
    }
    afterEach(() => {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    });

    async function composerStyle() {
      mockMobileViewport();
      stubApi();
      fakeClient.request.mockImplementation(async (method: unknown) => {
        if (method === rpcMethods.sessionList) return { sessions: [summary] };
        if (method === rpcMethods.sessionPendingWaiters)
          return { toolPermissions: [], askUserQuestions: [] };
        throw new Error("unexpected: " + method);
      });
      renderPage();
      const band = await screen.findByTestId("session-composer-band");
      await waitFor(() =>
        expect(band.querySelector(".ProseMirror")).toBeTruthy(),
      );
      return band.querySelector<HTMLElement>(
        '[style*="--chat-composer-max-h"]',
      );
    }

    it("键盘弹着（可视区 300px）：输入框最高 100px", async () => {
      setKeyboard(300);
      const el = await composerStyle();
      expect(el?.getAttribute("style")).toContain(
        "--chat-composer-max-h: 100px",
      );
    });

    it("键盘没弹：不限高，沿用包的默认", async () => {
      setKeyboard(null);
      expect(await composerStyle()).toBeNull();
    });
  });
});
