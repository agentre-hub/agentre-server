/**
 * 移动端「对话」页（规格 2026-08-17 决策 5 / 16，屏 20/32）：
 *   - 与桌面**同一套四个轴**：移动端不再有一份只属于自己的「按状态分组」。
 *   - 行同样来自账号镜像（规格 2026-08-18 决策 9），行尾不摆动作：账号里的每一条
 *     都已经保存过了，「保存」只出现在机器轴选中一台在线机器时列出的那些行上。
 *   - 空态沿用屏 32：文案与「开始第一个对话」主按钮原样不动。
 *   - 头部搜索是真实过滤（屏 20），空态时也一样可触达、且不制造结果。
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
  Route,
  Routes,
  useLocation,
  useNavigate,
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
import { useRelayChannel, type UseRelayChannelResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Chat from "@/pages/Chat";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));
// 长按「停止这一轮」走中继池借一条通道发 runtime.abort；这里只认它借的是哪条通道、
// 发了什么。
const { abortRequest } = vi.hoisted(() => ({
  abortRequest: vi.fn(async (..._args: unknown[]) => ({})),
}));
vi.mock("@/lib/relayClientPool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayClientPool")>();
  return {
    ...actual,
    withRelayClient: vi.fn(
      async (
        target: string,
        fn: (client: {
          request: (...args: unknown[]) => Promise<unknown>;
        }) => Promise<unknown>,
      ) =>
        fn({
          request: (...args: unknown[]) => abortRequest(target, ...args),
        }),
    ),
  };
});
// 会话详情本身由 session-detail*.test.tsx 守；这里只认 Chat 在移动端把哪一条、以什么
// 形态、带着哪条返回地址交给它。
vi.mock("@/components/session/SessionDetailView", () => ({
  default: (props: {
    deviceId: number;
    conversationId: string;
    form?: string;
    backTo?: string;
  }) => (
    <div
      data-testid="mobile-session-detail"
      data-device-id={props.deviceId}
      data-session-id={props.conversationId}
      data-form={props.form ?? "page"}
      data-back-to={props.backTo ?? ""}
    />
  ),
}));

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

const agentred = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};
/** 同一个账号下的另一台机器，此刻不在线。 */
const offlineMachine = {
  id: 2,
  name: "公司 Mac mini",
  kind: "agentred",
  fingerprint: "fp-2",
  last_seen_at: 1753000000000,
  status: 1,
  online: false,
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
        device_unspecified: false,
      },
    ],
  },
];
const waitingMirrored = {
  peer_fingerprint: "fp-1",
  device_fingerprint: "fp-1",
  conversation_id: "42",
  title: "等你批",
  agent_sync_id: "ag-1",
  backend_type: "claudecode",
  lifecycle_state: "running",
  waiting_for_input: true,
  last_message_at: 1754800000000,
};
const runningMirrored = {
  peer_fingerprint: "fp-1",
  device_fingerprint: "fp-1",
  conversation_id: "43",
  title: "跑着呢",
  agent_sync_id: "ag-1",
  backend_type: "claudecode",
  lifecycle_state: "running",
  last_message_at: 1754700000000,
};

/** 索引的四条数据源；账号镜像里有哪几条由调用方给。 */
function stubApi(
  saved: unknown[],
  devices: unknown[] = [agentred],
  roster: { agents?: unknown[]; projects?: unknown[] } = {},
) {
  mockedApi.mockImplementation(async (path) => {
    if (path.startsWith("/v1/agent-sessions?")) {
      // 端点现在按轴给组骨架（规格 2026-08-19）：不带 scope 时一组一组地给。
      // 「等你处理」那个数由页面单独探一次，探测请求不该把行也发回去。
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      // 搜索与筛选现在都在服务端做（规格 2026-08-19 决策 8 / 9），替身照做：
      // 搜索只按标题，「未读」看 last_message_at > last_read_at，「运行中」收完整
      // running 生命周期集合（包含 waiting_for_input）。
      const q = params.get("q") ?? "";
      const filter = params.get("filter") ?? "";
      const scope = params.get("scope") ?? "";
      const rows = (saved as Record<string, unknown>[]).filter((row) => {
        if (q && !String(row.title ?? "").includes(q)) return false;
        if (
          scope.startsWith("agent:") &&
          row.agent_sync_id !== scope.slice("agent:".length)
        )
          return false;
        if (filter === "unread")
          return (
            row.lifecycle_state !== "running" &&
            Number(row.last_message_at ?? 0) > Number(row.last_read_at ?? 0)
          );
        if (filter === "running") return row.lifecycle_state === "running";
        return true;
      });
      if (params.get("per_group") === "1") return { total: rows.length };
      // 带 scope 时端点给的是那一组的行，不是组骨架（chatRows 的 IndexResponse）。
      if (scope) return { total: rows.length, items: rows, has_more: false };
      return {
        total: rows.length,
        groups: rows.length
          ? [{ scope: "time", total: rows.length, items: rows }]
          : [],
      };
    }
    if (path === "/v1/devices") return { devices };
    if (path === "/v1/workspace/agents")
      return { agents: roster.agents ?? agents };
    if (path === "/v1/workspace/projects")
      return { projects: roster.projects ?? [] };
    throw new Error("unexpected: " + path);
  });
}

/** 机器轴上那台在线机器交出的清单（账号里没有它，行尾因此是「保存」）。 */
const onMachineOnly = {
  conversationId: "77",
  title: "机器上才有的",
  agentSyncId: "ag-1",
  cwd: "/home/agent/proj",
  backendType: "claudecode",
  lifecycleState: "idle",
  latestSeq: 1,
};

const fakeClient = {
  request: vi.fn(async (method: unknown) => {
    if (method === rpcMethods.sessionList) return { sessions: [onMachineOnly] };
    throw new Error("unexpected method: " + method);
  }),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

function connectedRelay(): UseRelayChannelResult {
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
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockMobileViewport();
  mockedApi.mockReset();
  mockUseRelay.mockReset();
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="chat-location">{location.pathname + location.search}</p>
  );
}

/** 浏览器的后退键：详情被替身顶掉了，它自己那颗返回不在屏上。 */
function HistoryBack() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="history-back"
      onClick={() => navigate(-1)}
    >
      history back
    </button>
  );
}

function renderChat(entry = "/chat") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ThemeProvider>
        <LocationProbe />
        <HistoryBack />
        <Routes>
          <Route path="/chat/:conversationId?" element={<Chat />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("移动端对话页:决策 5/16 + 空态屏 32", () => {
  /**
   * 机器轴上「账号里一条都没保存过」说明不了这一轴有没有东西——它列的是**机器上**
   * 的清单（规格 2026-08-21）。移动端把索引整块让给主空态的判据此前只看账号，于是
   * 这一轴在窄屏上是一片空白：机器明明交出了清单，屏幕上却写着「你还没有对话」。
   */
  it("机器轴:账号里一条都没保存过,机器上的清单照样列得出来", async () => {
    stubApi([], [agentred]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat("/chat?axis=machine");

    expect(await screen.findByText("机器上才有的")).toBeTruthy();
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
  });

  it("账号镜像里的行行尾不摆动作(它们都已经保存过了)", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("底部弹层是 flex 列：Agent 清单那一格被限高、能滚，不被 grid 行撑出屏外", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const sheet = await screen.findByTestId("new-conversation-sheet");
    // DialogContent 默认是 grid：子项的 flex-1/min-h-0 不生效，清单那一格随内容长高，
    // 整层溢出 82dvh 落到屏幕下面，Agent 一多就够不着。
    expect(sheet.classList.contains("grid")).toBe(false);
    expect(sheet.classList.contains("flex")).toBe(true);
    expect(sheet.classList.contains("flex-col")).toBe(true);
  });

  it("从弹层挑 Agent 进草稿，草稿的返回回到列表，不再把挑 Agent 的弹层升起来", async () => {
    stubApi([waitingMirrored]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const sheet = await screen.findByTestId("new-conversation-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: /后端 Agent/ }));
    expect(await screen.findByTestId("draft-session")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() =>
      expect(screen.queryByTestId("draft-session")).toBeNull(),
    );
    expect(screen.queryByTestId("new-conversation-sheet")).toBeNull();
    expect(screen.getByText("等你批")).toBeTruthy();
  });

  it("真空账号开始搜索后挂共享搜索空态，并可清除搜索回到主空态", async () => {
    stubApi([], []);
    renderChat();

    expect(await screen.findByTestId("chat-empty-state")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Search conversation titles" }),
    );
    const search = screen.getByRole("searchbox", {
      name: "Search conversation titles",
    });
    fireEvent.change(search, { target: { value: "跑着呢" } });

    const empty = await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-slot="session-index-empty"]',
      );
      expect(target).not.toBeNull();
      return target as HTMLElement;
    });
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
    expect(empty.textContent).toContain("No matching sessions");

    fireEvent.click(
      within(empty).getByRole("button", { name: "Clear search" }),
    );
    expect(await screen.findByTestId("chat-empty-state")).toBeTruthy();
  });

  it("筛选清空移动列表时挂共享筛选空态，且筛选优先于账号真空态", async () => {
    stubApi([
      {
        ...waitingMirrored,
        lifecycle_state: "idle",
        last_read_at: 1754800001000,
      },
    ]);
    renderChat();
    await screen.findByText("等你批");

    fireEvent.click(screen.getByTestId("filter-chip-running"));

    const empty = await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-slot="session-index-empty"]',
      );
      expect(target).not.toBeNull();
      return target as HTMLElement;
    });
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
    expect(empty.textContent).toContain("No running sessions");
    expect(
      within(empty).getByRole("button", { name: "View all sessions" }),
    ).toBeTruthy();
  });

  // 搜索与筛选同一条口径：只收窄行。搜不到不等于账号里没有对话——把整页翻成
  // 「还没有对话 / 开始第一个对话」等于替用户否认了那些还在的会话。
  it("搜不到时不谎报「还没有对话」：主空态不出现，说的是这次搜索没有匹配", async () => {
    stubApi([waitingMirrored, runningMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Search conversation titles" }),
    );
    const search = screen.getByRole("searchbox", {
      name: "Search conversation titles",
    });
    fireEvent.change(search, { target: { value: "查无此条" } });

    const empty = await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-slot="session-index-empty"]',
      );
      expect(target).not.toBeNull();
      return target as HTMLElement;
    });
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
    expect(empty.textContent).toContain("No matching sessions");
  });
});

/**
 * 移动端顶部：这一带由页面自己排（壳的 ownHeader），手机上是「☰ · 范围名 · ⌕ · ✎」
 * 一行（规格 2026-11-05「首页」）；账号、语言与主题都进了抽屉。
 */
describe("移动端对话页：顶部", () => {
  it("页面自己画顶栏，壳不再另画一条——整页只有一条 header", async () => {
    stubApi([waitingMirrored]);
    const { container } = renderChat();

    await screen.findByText("等你批");
    expect(container.querySelectorAll("header")).toHaveLength(1);
    const head = screen.getByTestId("chat-mobile-header");
    // 这一条顶栏不走壳，安全区得自己让：少了它，刘海机上内容会伸到状态栏底下。
    expect(head.className).toContain("pt-[env(safe-area-inset-top,0px)]");
  });
});

/*
  手机上新建对话的两屏（草稿、从项目挑 Agent）各占一整屏，盖住了索引那条页头；
  壳走 ownHeader 不画顶栏，手机上又没有侧栏——语言/主题此前在这两屏上一颗都没有。
  它们落在各自页头的右端，与索引页头同一组（AppControls），整屏只有一份。
*/
describe("移动端新建对话：语言/主题", () => {
  function expectAppControlsIn(head: HTMLElement) {
    expect(
      within(head).getByRole("button", { name: /Language/i }),
    ).toBeTruthy();
    expect(within(head).getByRole("button", { name: /Theme/i })).toBeTruthy();
    // 索引那条页头此刻不在：屏上只有这一份，不是两份叠着。
    expect(screen.getAllByRole("button", { name: /Language/i })).toHaveLength(
      1,
    );
  }

  it("草稿那一屏的页头带着语言/主题", async () => {
    stubApi([waitingMirrored]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const sheet = await screen.findByTestId("new-conversation-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: /后端 Agent/ }));
    await screen.findByTestId("draft-session");

    expectAppControlsIn(screen.getByTestId("draft-header"));
  });

  it("「从项目里挑」那一屏的页头带着语言/主题", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const sheet = await screen.findByTestId("new-conversation-sheet");
    fireEvent.click(
      within(sheet).getByRole("button", {
        name: "Pick an agent from a project",
      }),
    );
    const pane = await screen.findByTestId("project-agent-pane");

    const head = pane.querySelector("header");
    expect(head).not.toBeNull();
    expectAppControlsIn(head as HTMLElement);
  });
});

/*
  这两屏铺满整个手机屏，壳走 ownHeader 不画顶栏、也就不替它们让安全区：
  viewport-fit=cover 之后页头会钻到刘海/状态栏底下。与索引页头同一个让法
  （pt-[env(safe-area-inset-top,0px)]），只在手机整屏形态；桌面右栏不让——
  它上面是外框，不贴屏幕顶。断言沿祖先链找：让在页头本身还是它那一格整屏
  容器上都算，只要页头确实被推到安全区下面。
*/
describe("移动端新建对话：顶部安全区", () => {
  const SAFE_TOP = "pt-[env(safe-area-inset-top,0px)]";

  function insetHolder(el: HTMLElement): HTMLElement | null {
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (typeof n.className === "string" && n.className.includes(SAFE_TOP)) {
        return n;
      }
    }
    return null;
  }

  async function openDraft() {
    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const sheet = await screen.findByTestId("new-conversation-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: /后端 Agent/ }));
    await screen.findByTestId("draft-session");
    return screen.getByTestId("draft-header");
  }

  async function openProjectPane() {
    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const sheet = await screen.findByTestId("new-conversation-sheet");
    fireEvent.click(
      within(sheet).getByRole("button", {
        name: "Pick an agent from a project",
      }),
    );
    const pane = await screen.findByTestId("project-agent-pane");
    return pane.querySelector("header") as HTMLElement;
  }

  it("草稿那一屏的页头让出顶部安全区", async () => {
    stubApi([waitingMirrored]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(insetHolder(await openDraft())).not.toBeNull();
  });

  it("草稿那一屏只让一次：壳的 immersive 已经让过，整屏容器不再叠一层", async () => {
    stubApi([waitingMirrored]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    const head = await openDraft();
    const holders: HTMLElement[] = [];
    for (let n: HTMLElement | null = head; n; n = n.parentElement) {
      if (typeof n.className === "string" && n.className.includes(SAFE_TOP)) {
        holders.push(n);
      }
    }
    expect(holders).toHaveLength(1);
  });

  it("「从项目里挑」那一屏的页头让出顶部安全区", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    const head = await openProjectPane();
    expect(head).not.toBeNull();
    expect(insetHolder(head)).not.toBeNull();
  });

  it("桌面右栏里的这两屏不让：它们不贴屏幕顶", async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    stubApi([waitingMirrored]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "New conversation" })[0],
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Pick an agent from a project",
      }),
    );
    const pane = await screen.findByTestId("project-agent-pane");
    expect(insetHolder(pane.querySelector("header") as HTMLElement)).toBeNull();

    fireEvent.click(within(pane).getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: /后端 Agent/ }));
    await screen.findByTestId("draft-session");
    expect(insetHolder(screen.getByTestId("draft-header"))).toBeNull();
  });
});

/**
 * 移动端的会话地址（规格 2026-09-17-chat-session-url「Mobile」）：会话号在地址上时
 * 整屏是那条会话的详情，返回回到进来时那份范围的列表。
 */
describe("移动端对话页：会话地址", () => {
  it("点一行进 /chat/:id，整屏换成详情，返回键回到带着原范围的 /chat", async () => {
    stubApi([waitingMirrored]);
    renderChat("/chat?axis=agent");

    fireEvent.click(await screen.findByRole("link", { name: /等你批/ }));

    const detail = await screen.findByTestId("mobile-session-detail");
    expect(screen.getByTestId("chat-location").textContent).toBe(
      "/chat/42?axis=agent",
    );
    expect(detail.getAttribute("data-form")).toBe("page");
    expect(detail.getAttribute("data-device-id")).toBe("1");
    expect(detail.getAttribute("data-back-to")).toBe("/chat?axis=agent");
    // 单列：索引此刻不在屏上。
    expect(screen.queryByTestId("chat-mobile-header")).toBeNull();
  });

  it("未保存的会话从外部链接直接打开：返回键回到 /chat，不带 device", async () => {
    stubApi([]);
    renderChat("/chat/11111111-1111-7111-8111-111111111111?device=1");

    const detail = await screen.findByTestId("mobile-session-detail");
    expect(detail.getAttribute("data-device-id")).toBe("1");
    expect(detail.getAttribute("data-back-to")).toBe("/chat");
  });
});

/**
 * 移动端新对话草稿（规格 2026-09-21-server-mobile-gaps 决策 3）：与会话详情同一种
 * 沉浸形态——底部 tab 不画，只剩草稿自己的一层头部；还没有标题时叫「新对话」，副行
 * 说得出 Agent 与将在哪台机器上跑。
 */
describe("移动端新对话草稿：一层头部", () => {
  const plan = {
    agent_sync_id: "ag-1",
    tiers: [
      {
        rank: 1,
        backend_sync_id: "b-a",
        device_id: 1,
        device_name: "书房小主机",
        backend_type: "claudecode",
        kind: "agentred",
        availability: "available",
        current: true,
      },
    ],
    chosen: {
      device_fingerprint: "fp-1",
      device_id: 1,
      device_name: "书房小主机",
      backend_sync_id: "b-a",
      backend_type: "claudecode",
      kind: "agentred",
    },
    projects: [],
  };

  async function openMobileDraft() {
    stubApi([waitingMirrored]);
    const listing = mockedApi.getMockImplementation()!;
    mockedApi.mockImplementation(async (path, ...rest) => {
      if (String(path).startsWith("/v1/workspace/dispatch-target?"))
        return plan;
      return listing(path, ...rest);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();
    fireEvent.click(
      await screen.findByRole("button", { name: "New conversation" }),
    );
    fireEvent.click(await screen.findByTestId("agent-pick-ag-1"));
    return screen.findByTestId("draft-header");
  }

  it("底部 tab 与页面顶栏都不画", async () => {
    await openMobileDraft();

    expect(screen.queryByTestId("app-topbar")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Agentre Server" }),
    ).toBeNull();
  });

  it("还没有标题时叫「新对话」，副行是 Agent · 机器", async () => {
    const band = await openMobileDraft();

    expect(
      within(band).getByRole("heading", { name: "New chat" }),
    ).toBeTruthy();
    expect(within(band).getByRole("button", { name: "Back" })).toBeTruthy();
    const meta = within(band).getByTestId("draft-header-meta");
    expect(
      within(meta).getByTestId("draft-header-meta-agent").textContent,
    ).toContain("后端 Agent");
    const machine = await within(meta).findByTestId(
      "draft-header-meta-machine",
    );
    expect(machine.textContent).toContain("书房小主机");
    for (const part of meta.querySelectorAll("[data-part]")) {
      expect(part.className).not.toMatch(/hidden/);
    }
  });
});

describe("移动端对话页:空态 W8 页内切机器轴", () => {
  it("账号空且有在线机器:页内按钮切到机器轴,不再去设备页", async () => {
    stubApi([], [agentred]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    const empty = await screen.findByTestId("chat-empty-state");
    expect(
      within(empty).queryByRole("link", { name: "Add a device" }),
    ).toBeNull();
    fireEvent.click(
      within(empty).getByRole("button", {
        name: "Browse conversations by machine",
      }),
    );
    expect(screen.getByTestId("chat-location").textContent).toBe(
      "/chat?axis=machine",
    );
  });

  it("账号空且没有在线机器:出口是「添加设备」，指向 /devices", async () => {
    stubApi([], []);
    renderChat();

    const empty = await screen.findByTestId("chat-empty-state");
    expect(
      within(empty).queryByRole("button", {
        name: "Browse conversations by machine",
      }),
    ).toBeNull();
    expect(
      within(empty)
        .getByRole("link", { name: "Add a device" })
        .getAttribute("href"),
    ).toBe("/devices");
  });
});

/**
 * 手机首页（规格 2026-11-05-mobile-pwa-shell「首页（对话列表）」）：页头
 * ☰ · 范围名 ⌄（副标题）· ⌕ · ✎；筛选胶囊；按 需要你 / 进行中 / 今天 / 更早 分段；
 * 手机行；搜索与高亮；长按菜单；空态出口；离线副标题；返回恢复。
 */
describe("手机首页：对话列表", () => {
  const now = Date.now();
  /** 今天早些时候结束、还没读过的一条（未读点）。 */
  const unreadToday = {
    peer_fingerprint: "fp-1",
    device_fingerprint: "fp-1",
    conversation_id: "44",
    title: "读一下迁移",
    agent_sync_id: "ag-1",
    backend_type: "claudecode",
    lifecycle_state: "idle",
    last_message_at: now - 60_000,
    last_read_at: 0,
  };
  /** 很早以前的一条，读过了。 */
  const oldRead = {
    peer_fingerprint: "fp-1",
    device_fingerprint: "fp-1",
    conversation_id: "45",
    title: "老对话",
    agent_sync_id: "ag-1",
    backend_type: "claudecode",
    lifecycle_state: "idle",
    last_message_at: 1754000000000,
    last_read_at: 1754000001000,
  };
  const all = [waitingMirrored, runningMirrored, unreadToday, oldRead];

  it("页头：☰ · 范围名 ⌄ 与「N / M 台机器在线」· ⌕ · ✎，没有浮动按钮", async () => {
    stubApi(all, [agentred, offlineMachine]);
    renderChat();

    await screen.findByText("等你批");
    const head = screen.getByTestId("chat-mobile-header");
    expect(
      within(head).getByRole("button", { name: "Open menu" }),
    ).toBeTruthy();
    const scope = within(head).getByRole("button", {
      name: "Switch scope, current: All",
    });
    expect(
      within(scope).getByTestId("chat-phone-subtitle").textContent,
    ).toContain("1 / 2 machines online");
    expect(
      within(head).getByRole("button", { name: "Search conversation titles" }),
    ).toBeTruthy();
    // ✎ 在页头里，整页只有这一颗新对话入口（不再有右下角的浮动按钮）。
    const compose = screen.getAllByRole("button", { name: "New conversation" });
    expect(compose).toHaveLength(1);
    expect(head.contains(compose[0])).toBe(true);
    fireEvent.click(compose[0]);
    expect(await screen.findByTestId("new-conversation-sheet")).toBeTruthy();
  });

  it("范围名是一颗按钮，点它交给 onOpenScope（弹层由后续接上）", async () => {
    stubApi(all);
    renderChat();

    await screen.findByText("等你批");
    const scope = screen.getByRole("button", {
      name: "Switch scope, current: All",
    });
    expect(scope.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("手机上没有轴选择器：列表按 需要你 → 进行中 → 今天 → 更早 分段，空段不显示", async () => {
    stubApi(all);
    renderChat();

    await screen.findByText("等你批");
    expect(screen.queryByTestId("axis-picker")).toBeNull();
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid^='phase-']"),
    );
    expect(sections.map((s) => s.getAttribute("data-testid"))).toEqual([
      "phase-needsYou",
      "phase-inProgress",
      "phase-today",
      "phase-earlier",
    ]);
    expect(
      within(sections[0]).getByRole("heading", { name: "Needs you" }),
    ).toBeTruthy();
    expect(within(sections[0]).getByText("等你批")).toBeTruthy();
    expect(within(sections[1]).getByText("跑着呢")).toBeTruthy();
    expect(within(sections[2]).getByText("读一下迁移")).toBeTruthy();
    expect(within(sections[3]).getByText("老对话")).toBeTruthy();
  });

  it("空段不显示", async () => {
    stubApi([unreadToday]);
    renderChat();

    await screen.findByText("读一下迁移");
    expect(screen.getByTestId("phase-today")).toBeTruthy();
    expect(screen.queryByTestId("phase-needsYou")).toBeNull();
    expect(screen.queryByTestId("phase-inProgress")).toBeNull();
    expect(screen.queryByTestId("phase-earlier")).toBeNull();
  });

  it("手机行：第二行「Agent · 项目」，状态牌或未读点（未读走唯一判据）", async () => {
    stubApi(all);
    renderChat();

    const waitingRow = (await screen.findByText("等你批")).closest("a")!;
    expect(waitingRow.textContent).toContain("后端 Agent");
    expect(within(waitingRow).getByText("Needs you")).toBeTruthy();
    const runningRow = screen.getByText("跑着呢").closest("a")!;
    expect(within(runningRow).getByText("Running")).toBeTruthy();
    const unreadRow = screen.getByText("读一下迁移").closest("a")!;
    expect(within(unreadRow).getByRole("img", { name: "Unread" })).toBeTruthy();
    const readRow = screen.getByText("老对话").closest("a")!;
    expect(within(readRow).queryByRole("img", { name: "Unread" })).toBeNull();
  });

  it("筛选胶囊：全部 / 需要你 / 进行中 / 未读，数字只在大于 0 时出现，命中区 44px", async () => {
    stubApi(all);
    renderChat();

    await screen.findByText("等你批");
    const chips = ["all", "attention", "running", "unread"].map((v) =>
      screen.getByTestId(`filter-chip-${v}`),
    );
    expect(chips.map((c) => c.className.includes("min-h-11"))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(chips[2].textContent).toContain("In progress");
    expect(chips[0].querySelector("[data-slot='unread-count']")).toBeNull();
    for (const chip of chips.slice(1)) {
      await waitFor(() =>
        expect(
          chip.querySelector("[data-slot='unread-count']")?.textContent,
        ).toBe("1"),
      );
    }
  });

  it("「需要你」只留等你的那几条，「进行中」不含等你的", async () => {
    stubApi(all);
    renderChat();

    await screen.findByText("等你批");
    fireEvent.click(screen.getByTestId("filter-chip-attention"));
    await waitFor(() => expect(screen.queryByText("跑着呢")).toBeNull());
    expect(screen.getByText("等你批")).toBeTruthy();
    expect(screen.queryByText("老对话")).toBeNull();

    fireEvent.click(screen.getByTestId("filter-chip-running"));
    await waitFor(() => expect(screen.queryByText("等你批")).toBeNull());
    expect(screen.getByText("跑着呢")).toBeTruthy();
  });

  it("「需要你」一条不剩时挂共享筛选空态", async () => {
    stubApi([runningMirrored]);
    renderChat();

    await screen.findByText("跑着呢");
    fireEvent.click(screen.getByTestId("filter-chip-attention"));
    const empty = await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        '[data-slot="session-index-empty"]',
      );
      expect(target).not.toBeNull();
      return target as HTMLElement;
    });
    expect(empty.textContent).toContain("No sessions need you");
  });

  it("⌕ 把页头换成输入框 + 取消，写明在哪个范围搜、命中几条，命中字高亮", async () => {
    stubApi(all);
    renderChat();

    await screen.findByText("等你批");
    fireEvent.click(
      screen.getByRole("button", { name: "Search conversation titles" }),
    );
    const box = screen.getByRole("searchbox", {
      name: "Search conversation titles",
    });
    expect(
      screen.queryByRole("button", { name: "Switch scope, current: All" }),
    ).toBeNull();
    fireEvent.change(box, { target: { value: "迁移" } });

    await waitFor(() => expect(screen.queryByText("等你批")).toBeNull());
    const hit = await screen.findByText("迁移", { selector: "mark" });
    expect(hit.closest("a")?.textContent).toContain("读一下迁移");
    expect(screen.getByTestId("chat-phone-search-scope").textContent).toContain(
      "All",
    );
    expect(screen.getByTestId("chat-phone-search-scope").textContent).toContain(
      "1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("button", { name: "Switch scope, current: All" }),
    ).toBeTruthy();
    expect(await screen.findByText("等你批")).toBeTruthy();
  });

  it("长按运行中的一行：停止这一轮 / 只看这个 Agent / 只看这台机器 / 删除；停止走 runtime.abort", async () => {
    abortRequest.mockClear();
    stubApi(all);
    renderChat();

    const row = (await screen.findByText("跑着呢")).closest("a")!;
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items).toEqual([
      "Stop this turn",
      "Only this agent",
      "Only this machine",
      "Delete",
    ]);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Stop this turn" }),
    );
    await waitFor(() => expect(abortRequest).toHaveBeenCalledTimes(1));
    const [target, method, params] = abortRequest.mock.calls[0];
    expect(target).toBe("conversation:43");
    expect(method).toBe(rpcMethods.runtimeAbort);
    expect(params).toMatchObject({ conversationId: "43" });
  });

  it("没在跑、或机器离线时，长按菜单里没有「停止这一轮」", async () => {
    stubApi(
      [oldRead, { ...runningMirrored, device_fingerprint: "fp-2" }],
      [agentred, offlineMachine],
    );
    renderChat();

    fireEvent.contextMenu((await screen.findByText("老对话")).closest("a")!);
    let menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: "Stop this turn" }),
    ).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.contextMenu(screen.getByText("跑着呢").closest("a")!);
    menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: "Stop this turn" }),
    ).toBeNull();
  });

  it("「只看这个 Agent」换整页范围：地址、标题与取数都收到这个 Agent", async () => {
    stubApi(all);
    renderChat();

    fireEvent.contextMenu((await screen.findByText("跑着呢")).closest("a")!);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Only this agent",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-location").textContent).toBe(
        "/chat?axis=agent&agent=ag-1",
      ),
    );
    expect(
      await screen.findByRole("button", {
        name: "Switch scope, current: 后端 Agent",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        mockedApi.mock.calls.some(([path]) =>
          String(path).includes("scope=agent%3Aag-1"),
        ),
      ).toBe(true),
    );
  });

  it("「只看这台机器」换到机器范围", async () => {
    stubApi(all);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    fireEvent.contextMenu((await screen.findByText("跑着呢")).closest("a")!);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Only this machine",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-location").textContent).toBe(
        "/chat?axis=machine&machine=1",
      ),
    );
    expect(
      await screen.findByRole("button", {
        name: "Switch scope, current: 书房小主机",
      }),
    ).toBeTruthy();
  });

  it("空态：主按钮「新对话」撑满宽", async () => {
    stubApi([], [agentred]);
    renderChat();

    const empty = await screen.findByTestId("chat-empty-state");
    const primary = within(empty).getByRole("button", {
      name: "New conversation",
    });
    expect(primary.className).toContain("w-full");
    // 空态**只有一个**——索引交白卷时由它承接，而不是自己再印一遍同一句话。
    expect(screen.getAllByText("No conversations yet.").length).toBe(1);
    expect(screen.getByText("Pick an agent to get started.")).toBeTruthy();
    fireEvent.click(primary);
    expect(await screen.findByTestId("new-conversation-sheet")).toBeTruthy();
  });

  describe("离线副标题", () => {
    const onLine = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator),
      "onLine",
    );
    function goOffline() {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    }
    afterEach(() => {
      delete (navigator as { onLine?: boolean }).onLine;
      if (onLine)
        Object.defineProperty(
          Object.getPrototypeOf(navigator),
          "onLine",
          onLine,
        );
    });

    it("列表载入后断网：副标题换成「没有网络 · HH:MM 的内容」，列表照常可读", async () => {
      stubApi(all);
      renderChat();

      await screen.findByText("等你批");
      act(() => goOffline());
      const subtitle = await screen.findByTestId("chat-phone-subtitle");
      await waitFor(() =>
        expect(subtitle.textContent).toMatch(
          /No network · content from \d{2}:\d{2}/,
        ),
      );
      expect(screen.getByText("等你批")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();

      act(() => {
        delete (navigator as { onLine?: boolean }).onLine;
        window.dispatchEvent(new Event("online"));
      });
      await waitFor(() =>
        expect(subtitle.textContent).toContain("machines online"),
      );
    });

    it("还没载入就断网：不换副标题", async () => {
      stubApi(all);
      const listing = mockedApi.getMockImplementation()!;
      mockedApi.mockImplementation(async (path, ...rest) => {
        if (String(path).startsWith("/v1/agent-sessions?"))
          return new Promise(() => {});
        return listing(path, ...rest);
      });
      renderChat();

      const subtitle = await screen.findByTestId("chat-phone-subtitle");
      act(() => goOffline());
      expect(subtitle.textContent).not.toMatch(/No network/);
    });
  });

  it("从对话返回列表：同一范围下恢复滚动位置与筛选", async () => {
    stubApi(all);
    renderChat();

    await screen.findByText("等你批");
    fireEvent.click(screen.getByTestId("filter-chip-attention"));
    await waitFor(() => expect(screen.queryByText("跑着呢")).toBeNull());
    const list = screen.getByTestId("chat-phone-list");
    list.scrollTop = 120;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByRole("link", { name: /等你批/ }));
    await screen.findByTestId("mobile-session-detail");
    fireEvent.click(screen.getByTestId("history-back"));

    const restored = await screen.findByTestId("chat-phone-list");
    expect(
      screen.getByTestId("filter-chip-attention").getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() => expect(restored.scrollTop).toBe(120));
  });
});
