/**
 * 移动端「对话」页（规格 2026-08-17 决策 5 / 16，屏 20/32）：
 *   - 与桌面**同一套四个轴**：移动端不再有一份只属于自己的「按状态分组」。
 *   - 行同样来自账号镜像（规格 2026-08-18 决策 9），行尾不摆动作：账号里的每一条
 *     都已经保存过了，「保存」只出现在机器轴选中一台在线机器时列出的那些行上。
 *   - 空态沿用屏 32：文案与「开始第一个对话」主按钮原样不动。
 *   - 头部搜索是真实过滤（屏 20），空态时也一样可触达、且不制造结果。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine, type UseRelayMachineResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
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
        is_local_reference: false,
      },
    ],
  },
];
const waitingMirrored = {
  peer_fingerprint: "fp-1",
  machine_fingerprint: "fp-1",
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
  machine_fingerprint: "fp-1",
  conversation_id: "43",
  title: "跑着呢",
  agent_sync_id: "ag-1",
  backend_type: "claudecode",
  lifecycle_state: "running",
  last_message_at: 1754700000000,
};

/** 索引的四条数据源；账号镜像里有哪几条由调用方给。 */
function stubApi(saved: unknown[], devices: unknown[] = [agentred]) {
  mockedApi.mockImplementation(async (path) => {
    if (path.startsWith("/v1/agent-sessions?")) {
      // 端点现在按轴给组骨架（规格 2026-08-19）：不带 scope 时一组一组地给。
      // 「等你处理」那个数由页面单独探一次，探测请求不该把行也发回去。
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      // 搜索与筛选现在都在服务端做（规格 2026-08-19 决策 8 / 9），替身照做：
      // 搜索只按标题，「未读」看 last_message_at > last_read_at，「运行中」是 running
      // 且不等待。
      const q = params.get("q") ?? "";
      const filter = params.get("filter") ?? "";
      const rows = (saved as Record<string, unknown>[]).filter((row) => {
        if (q && !String(row.title ?? "").includes(q)) return false;
        if (filter === "unread")
          return Number(row.updated_at ?? 0) > Number(row.last_read_at ?? 0);
        if (filter === "running")
          return row.lifecycle_state === "running" && !row.waiting_for_input;
        return true;
      });
      if (params.get("per_group") === "1") return { total: rows.length };
      return {
        total: rows.length,
        groups: rows.length
          ? [{ scope: "time", total: rows.length, items: rows }]
          : [],
      };
    }
    if (path === "/v1/devices") return { devices };
    if (path === "/v1/workspace/agents") return { agents };
    if (path === "/v1/workspace/projects") return { projects: [] };
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

function connectedRelay(): UseRelayMachineResult {
  return {
    client: fakeClient as never,
    relayState: "connected",
    relayTicket: {
      clientId: "fp-web",
      clientName: "Browser",
      accessToken: "t",
    },
    relayTicketError: null,
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

function renderChat(entry = "/chat") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ThemeProvider>
        <Routes>
          <Route path="/chat" element={<Chat />} />
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

  /**
   * 同一条判据的另一半：机器**答不出**的时候这一轴上仍然有东西可说——那台机器
   * 自己（规格 2026-08-21「机器轴列什么」：「组头标「离线」/「连不上」，这一组
   * 一行都不列」，以及用户故事 3「我要那台机器仍然在列表上、并如实说它离线」）。
   * 拿「有没有行」当判据的话，账号又是空的时候整个索引会被主空态吞掉，屏幕上
   * 写着「你还没有对话」——而那台机器在不在、是什么状态，一个字都读不到。
   */
  it("机器轴:账号空、机器又离线,组头照样在并如实说离线", async () => {
    stubApi([], [offlineMachine]);
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat("/chat?axis=machine");

    const box = await screen.findByTestId("group-device-2");
    expect(within(box).getByText("公司 Mac mini")).toBeTruthy();
    expect(screen.getByTestId("group-offline-device-2")).toBeTruthy();
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
  });

  /**
   * 在线、清单交出来了、里面是空的：规格要「空组保留组头，组里给一句『这台机器上
   * 还没有对话』」。账号也空的时候这一句同样不能被主空态换成「你还没有对话」——
   * 后者说的是账号，而这一轴问的是机器。
   */
  it("机器轴:账号空、机器交出的清单也是空的,组头与那句说明都还在", async () => {
    stubApi([], [agentred]);
    mockUseRelay.mockReturnValue({
      ...connectedRelay(),
      client: {
        request: vi.fn(async () => ({
          sessions: [],
        })),
        attach: vi.fn(async () => ({})),
        catchUp: vi.fn(async () => {}),
        close: vi.fn(),
      } as never,
    });
    renderChat("/chat?axis=machine");

    const box = await screen.findByTestId("group-device-1");
    expect(
      await within(box).findByText("No conversations on this machine yet."),
    ).toBeTruthy();
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
  });

  it("与桌面同一套四个轴:轴选择器在,没有只属于移动端的状态分组", async () => {
    stubApi([waitingMirrored, runningMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.getByTestId("axis-picker")).toBeTruthy();
    // 「等你处理 / 运行中」不再是移动端独有的一套分组维度（决策 5）。
    const headings = Array.from(document.querySelectorAll("h2")).map(
      (h) => h.textContent ?? "",
    );
    expect(headings.some((h) => /Waiting for you/.test(h))).toBe(false);
    expect(headings.some((h) => /Running/.test(h))).toBe(false);
    // 判不出项目的会话进「随手对话」（默认落在项目轴上）。
    expect(screen.getByText("Quick chats")).toBeTruthy();
  });

  // 决策 5 的另一半：移动端不再有自己的状态分组，正是因为「未读 / 运行中」
  // 已经是筛选 chip —— 那套 chip 因此必须在移动端也够得着。
  it("「未读 / 运行中」在移动端是筛选 chip，点了真收窄", async () => {
    stubApi([waitingMirrored, runningMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.getByText("跑着呢")).toBeTruthy();

    fireEvent.click(screen.getByTestId("filter-chip-running"));
    await waitFor(() => expect(screen.queryByText("等你批")).toBeNull());
    expect(screen.getByText("跑着呢")).toBeTruthy();
  });

  it("账号镜像里的行行尾不摆动作(它们都已经保存过了)", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("行的第二行补齐当前轴没说的那一维(项目轴上是机器)", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.getByTestId("row-secondary-42").textContent).toContain(
      "书房小主机",
    );
  });

  it("空态沿用屏 32:文案与「开始第一个对话」主按钮原样不动", async () => {
    stubApi([], []);
    renderChat();

    expect(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    ).toBeTruthy();
    // 空态**只有一个**——索引交白卷时由它承接，而不是自己再印一遍同一句话。
    expect(screen.getAllByText("No conversations yet.").length).toBe(1);
    expect(screen.getByText("Pick an agent to get started.")).toBeTruthy();
    // 主按钮升起「挑一个 Agent」的底部弹层（屏 23）。
    fireEvent.click(
      screen.getByRole("button", { name: "Start your first conversation" }),
    );
    expect(await screen.findByTestId("new-conversation-sheet")).toBeTruthy();
  });

  it("移动端有会话时也有新建入口(FAB)升起挑 Agent 的底部弹层(IC5sH)", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    // FAB 只在有会话时才渲染，所以它的可访问名不能是「开始第一个对话」——
    // 屏幕阅读器上那就是一句与事实相反的话。
    expect(
      screen.queryByRole("button", { name: "Start your first conversation" }),
    ).toBeNull();
    const fab = screen.getByRole("button", { name: "New conversation" });
    fireEvent.click(fab);
    expect(await screen.findByTestId("new-conversation-sheet")).toBeTruthy();
  });

  it("空态时也显示同一个真实搜索框（加载完成后不再因空隐藏），且不制造结果、不隐藏主空态", async () => {
    stubApi([], []);
    renderChat();

    expect(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    ).toBeTruthy();

    const search = screen.getByRole("searchbox", {
      name: i18n.t("chat.searchSessions"),
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

  // 规格「已知的可见变化」3：共享行的状态点可访问名收敛成英文状态码，移动端行尾
  // 因此保留本地化文字徽标兜底——状态不能只剩颜色。
  it("移动行尾保留本地化状态徽标（不只靠颜色）", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.getByText("Waiting for your input")).toBeTruthy();
  });

  // 搜索与筛选同一条口径：只收窄行。搜不到不等于账号里没有对话——把整页翻成
  // 「还没有对话 / 开始第一个对话」等于替用户否认了那些还在的会话。
  it("搜不到时不谎报「还没有对话」：主空态不出现，说的是这次搜索没有匹配", async () => {
    stubApi([waitingMirrored, runningMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    const search = screen.getByRole("searchbox", {
      name: i18n.t("chat.searchSessions"),
    });
    fireEvent.change(search, { target: { value: "查无此条" } });

    await waitFor(() => expect(screen.queryByText("等你批")).toBeNull());
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
    expect(screen.getByTestId("session-index-empty").textContent).toContain(
      "No conversations match your search",
    );
  });

  it("移动端也有可触达的真实搜索（屏 20 头部搜索）：输入词过滤索引里的行", async () => {
    stubApi([waitingMirrored, runningMirrored]);
    renderChat();

    expect(await screen.findByText("等你批")).toBeTruthy();
    expect(screen.getByText("跑着呢")).toBeTruthy();
    const search = screen.getByRole("searchbox", {
      name: i18n.t("chat.searchSessions"),
    });
    fireEvent.change(search, { target: { value: "跑着呢" } });
    await waitFor(() => expect(screen.queryByText("等你批")).toBeNull());
    expect(screen.getByText("跑着呢")).toBeTruthy();
  });
});

/**
 * 移动端顶部（2026-08-20 对话页 UI/UX 改版）。
 *
 * 此前是把桌面那一套 `right` 槽整个塞进壳的 52px 顶栏：标题被截成「对.」、
 * 「桌面端已连接」折成两行、「去设备上找对话」也折成两行，整条被撑到 ~100px
 * 还是挤的。窄屏上「标题 + 页面动作 + 账号 + 语言/主题」本来就不该抢同一行。
 *
 * 重画之后这一带由页面自己排（壳的 ownHeader）：第一行只留身份与全局控件
 * （标题 + 一枚带文字的连接 chip + 账号 + 语言/主题），搜索自成第二行。
 */
describe("移动端对话页：顶部", () => {
  it("页面自己画顶栏，壳不再另画一条——整页只有一条 header", async () => {
    stubApi([waitingMirrored]);
    const { container } = renderChat();

    await screen.findByText("等你批");
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(screen.getByTestId("chat-mobile-header")).toBeTruthy();
  });

  it("顶栏这一带装的是身份与全局控件 + 搜索，搜索不与标题抢同一行", async () => {
    stubApi([waitingMirrored]);
    renderChat();

    await screen.findByText("等你批");
    const head = screen.getByTestId("chat-mobile-header");
    expect(
      head.contains(
        screen.getByRole("searchbox", { name: "Search conversations" }),
      ),
    ).toBe(true);
    // 语言/主题这一组全局控件也在这一带里（它们此前住在壳的顶栏）。
    expect(head.querySelectorAll("button").length).toBeGreaterThan(1);
  });
});
