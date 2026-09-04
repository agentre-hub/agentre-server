/**
 * 「对话」页 = 这一端唯一的会话索引（规格 2026-08-17 决策 1），数据源改镜像
 * （规格 2026-08-18 决策 9）：
 *   - 行来自 server 的镜像（GET /v1/agent-sessions），不再逐台机器经中继实时
 *     解析，也不再上送 (机器指纹, cwd) 探针——项目归属随摘要一起下来（决策 12）。
 *   - 机器离线只是行上的一个状态（第二行末尾一段字），标题 / 状态 / 归属照常，
 *     行照常点得进去；「暂时看不到」那一整类行不再存在（决策 10）。
 *   - 机器轴选中一台**在线**机器时，索引额外列出那台机器上有、账号里还没保存的
 *     对话，行尾是「保存」（决策 11）。
 *   - 删除在行的右键菜单里，一次确认，文案按执行机在线与否分两套（决策 6 / 16）。
 *   - 这个账号第一次保存时先把「内容会存在 server 上」说清楚（隐私与承诺的变更）。
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
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine, type UseRelayMachineResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import * as accountChannel from "@/lib/accountChannel";
import { formatRelativeTime } from "@/lib/sessionView";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Chat from "@/pages/Chat";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});
// 桌面右栏嵌的是 task 5 的真实 SessionDetailView（其真实 relay/审批行为由
// session-detail.test.tsx 守）；本文件把真实详情 mock 成探针，只断言 Chat 以正确的
// deviceId/conversationId/form 消费它。
/**
 * 详情每次拿到的 onMarkedRead。它的**引用**是被守的东西：真实详情把这个 prop 列进
 * 了「session.list + attach + 补齐」那条 effect 的依赖数组，换一次引用就是让正开着
 * 的那条对话重跑一遍握手。
 */
const { markedReadProps } = vi.hoisted(() => ({
  markedReadProps: [] as unknown[],
}));

vi.mock("@/components/session/SessionDetailView", () => ({
  __esModule: true,
  default: (props: {
    deviceId: number;
    conversationId: string;
    peerFingerprint?: string;
    form?: "page" | "embedded";
    headerRight?: ReactNode;
    initialRow?: { conversation_id: string; title?: string };
    onMarkedRead?: (conversationId: string, lastReadAt: number) => void;
  }) => {
    markedReadProps.push(props.onMarkedRead);
    return (
      <div
        data-testid="embedded-session-detail"
        data-device-id={props.deviceId}
        data-session-id={props.conversationId}
        data-peer-fingerprint={props.peerFingerprint ?? ""}
        data-initial-row={props.initialRow?.conversation_id ?? ""}
        data-form={props.form ?? "page"}
      >
        embedded-detail
        {/* 顶带合并之后，页面级的那簇控件由 Chat 递进详情头部的右端（真实位置由
          session-detail.test.tsx 守）；这里只认它确实被递了进来。 */}
        <div data-testid="embedded-header-right">{props.headerRight}</div>
        {/* 真实详情把它标在哪个身份上、以及 /v1/agent-sessions/read 回的那个时刻
          原样递上来（时刻晚于 mirrored() 的 last_message_at，因此这一行从此不再
          算未读）。 */}
        <button
          type="button"
          onClick={() =>
            props.onMarkedRead?.(props.conversationId, 1754800001000)
          }
        >
          marked-read
        </button>
      </div>
    );
  },
}));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);

/** 把一条信号送进这个标签页共用的那条通道。 */
function deliver(signalType: string): void {
  const call = mockedStartChannel.mock.calls.at(-1);
  expect(call).toBeDefined();
  call![0].onRefresh(signalType);
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
const offlineMachine = {
  id: 2,
  name: "公司 Mac mini",
  kind: "agentred",
  fingerprint: "fp-2",
  last_seen_at: 1753000000000,
  status: 1,
  online: false,
};
const desktop = {
  id: 3,
  name: "工作 MacBook",
  kind: "desktop",
  fingerprint: "fp-desktop",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};
const agents = [
  {
    sync_id: "ag-1",
    name: "后端 Agent",
    avatar_color: "agent-3",
    avatar_icon: "bot",
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

/** 镜像里的一条：身份是（发起端指纹, 那一端的会话标识），没有 cwd（R19）。 */
function mirrored(over: Record<string, unknown> = {}) {
  return {
    peer_fingerprint: "fp-1",
    machine_fingerprint:
      over.machine_fingerprint ?? over.peer_fingerprint ?? "fp-1",
    conversation_id: "42",
    title: "重构登录页",
    agent_sync_id: "ag-1",
    backend_type: "claudecode",
    lifecycle_state: "idle",
    last_message_at: 1754800000000,
    ...over,
  };
}

/**
 * 机器上报的一条（只有机器轴选中一台在线机器时才用得到）。
 *
 * 带着 `peerFingerprint: "fp-1"` 是照实模拟：这是一条**在这台机器上**开的对话
 * （桌面端 / 本机 daemon），daemon 的 `session.list` 对浏览器这个调用方会如实交出
 * 它的发起端。省略 origin 说的是另一件事——「发起端就是本次调用的这一端」，也就是
 * 浏览器自己（见 chatRows.machineRowOrigin）；拿它当「这台机器」用会把两个身份
 * 混作一谈。
 */
const summary = {
  conversationId: "42",
  peerFingerprint: "fp-1",
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

function connectedRelay(): UseRelayMachineResult {
  return {
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
  };
}

/**
 * 机器轴一进来就对**每台在线机器**各开一条中继连接（规格 2026-08-21 决策 1），
 * 因此替身要按指纹分：两台机器共用一个 fake client 的话，两组列出来的是同一份。
 * 客户端按指纹缓存住——每次渲染现造一个的话，解析器会被它自己的依赖变化反复叫醒。
 */
const clientsByFingerprint = new Map<string, typeof fakeClient>();

function relayByMachine(sessionsByFingerprint: Record<string, unknown[]>) {
  mockUseRelay.mockImplementation((target) => {
    // hook 的入参现在是**通道目标**（决策 10/11）：机器轴走 machine:<fingerprint>。
    const fp = (target ?? "").replace(/^machine:/, "");
    let client = clientsByFingerprint.get(fp);
    if (!client) {
      client = {
        request: vi.fn(async (method: unknown) => {
          if (method === rpcMethods.sessionList)
            return {
              sessions: sessionsByFingerprint[fp] ?? [],
            };
          throw new Error("unexpected method: " + method);
        }),
        attach: vi.fn(async () => ({})),
        catchUp: vi.fn(async () => {}),
        close: vi.fn(),
      };
      clientsByFingerprint.set(fp, client);
    }
    return { ...connectedRelay(), client: client as never };
  });
}

/** 这一轮里索引每次请求带的参数，按发生顺序记下来供断言。 */
let indexRequests: URLSearchParams[] = [];

/**
 * 索引的四条数据源：镜像索引 / 设备 / Agent / 项目树。
 *
 * 索引那条现在带查询参数（axis/scope/cursor/q/filter…），因此按前缀匹配并把参数
 * 记下来。默认把 over.mirror 那批行摆成一个组骨架——「不带 scope 就给该轴全部组」
 * 是端点的形状，测试替身照着它来，否则守的就不是真实契约。
 */
function stubApi(
  over: Partial<{
    mirror: unknown[];
    devices: unknown[];
    agents: unknown[];
    projects: unknown[];
    total: number;
    index: (params: URLSearchParams) => unknown;
  }> = {},
) {
  mockedApi.mockImplementation(async (path) => {
    if (path.startsWith("/v1/agent-sessions?")) {
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      indexRequests.push(params);
      if (over.index) return over.index(params);
      const items = over.mirror ?? [];
      return {
        total: over.total ?? items.length,
        groups: [{ scope: "time", total: over.total ?? items.length, items }],
      };
    }
    if (path === "/v1/devices") return { devices: over.devices ?? [] };
    if (path === "/v1/workspace/agents")
      return { agents: over.agents ?? agents };
    if (path === "/v1/workspace/projects")
      return { projects: over.projects ?? [] };
    throw new Error("unexpected: " + path);
  });
}

/**
 * 「未读」chip 上那个数要的是完整集合上的真数，页面为它单独问一次
 * （axis=time&filter=unread&per_group=1）。断言索引本身时把这一条排掉，否则读到的
 * 永远是那次探测的参数。
 */
function isWaitingProbe(params: URLSearchParams): boolean {
  return (
    params.get("filter") === "unread" &&
    params.get("per_group") === "1" &&
    params.get("axis") === "time"
  );
}

/** 最后一次索引请求的参数（不含「等你处理」那次探测）。 */
function lastIndexRequest(): URLSearchParams {
  const real = indexRequests.filter((p) => !isWaitingProbe(p));
  const last = real[real.length - 1];
  if (!last) throw new Error("索引一次都没有请求过");
  return last;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  indexRequests = [];
  markedReadProps.length = 0;
  clientsByFingerprint.clear();
  fakeClient.request.mockReset();
  fakeClient.request.mockImplementation(async (method: unknown) => {
    if (method === rpcMethods.sessionList) return { sessions: [summary] };
    throw new Error("unexpected method: " + method);
  });
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

describe("对话页 = 统一会话索引", () => {
  it("空态:桌面 320px 左列 + 居中详情空态,TopBar 只注入连接态,主动作开新对话", async () => {
    stubApi();
    renderChat();

    // 桌面档的这一页自己画顶带：壳那条 52px 顶栏不再叠在上面，页标题也不重复
    // ——左侧导航同一时刻正高亮着「对话」。
    expect(screen.queryByTestId("app-topbar")).toBeNull();
    // 桌面形态:320px 左会话列表列 + 右侧详情区。宽度现在是内联的（可拖拽调），
    // 320 只是没拖过时的起点。
    const listCol = screen.getByTestId("chat-list-col");
    expect(listCol.style.width).toBe("320px");
    expect(screen.getByTestId("chat-detail")).toBeTruthy();
    // 决策 10：一条会话都没有时索引就是空的，不再拿账号下的 Agent 摆一列空组头。
    expect(await screen.findByTestId("session-index-empty")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /后端 Agent/ })).toBeNull();
    // 空态正文只留可执行的那一句，不再附带解释性的后半段。
    expect(screen.getByText("Pick an agent to get started.")).toBeTruthy();
    const startBtn = screen.getByRole("button", {
      name: "Start your first conversation",
    });
    const devLink = screen.getByRole("link", { name: /devices page/ });
    expect(devLink.getAttribute("href")).toBe("/devices");
    // 账号里一条都没有：侧栏「对话」那枚徽标只在 >0 时渲染，所以链接里没有数。
    expect(screen.getByRole("link", { name: /Chat/ }).textContent).toBe("Chat");
    expect(screen.queryByText("Desktop connected")).toBeNull();

    // 桌面不弹层：右栏本来就摆着空态，「挑一个 Agent」直接接管它。
    fireEvent.click(startBtn);
    expect(await screen.findByTestId("new-conversation-pane")).toBeTruthy();
  });

  /*
    转录上方此前叠着两条带：壳的 52px 顶栏（只放一个与侧栏高亮重复的「Chat」
    标题 + 连接态 + 语言/主题）和 89px 的详情头部，合计 141px 只承载了一行标题
    与一行 meta。两条并成一条 68px：这一页自己画顶带，页面级那簇控件（连接态 +
    语言/主题）跟着落到右栏顶带的右端——没选中对话时是右栏自己那条，选中之后
    就是详情头部本身，位置不跳。

    左列顶行同时抬到 68px：两列顶边因此是**同一条**横线，省下的 16px 换不来一条
    断开的顶边。
  */
  it("桌面顶带只剩一条：左右两列顶边齐平，页面级控件在右栏顶带里", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    renderChat();

    await screen.findByRole("link", { name: /重构登录页/ });
    expect(screen.queryByTestId("app-topbar")).toBeNull();

    const listHead = screen.getByTestId("chat-list-head");
    expect(listHead.className).toMatch(/h-\[68px\]/);
    const chrome = screen.getByTestId("chat-chrome");
    expect(chrome.className).toMatch(/h-\[68px\]/);
    // 语言 / 主题在这一端仍够得着——壳不画顶栏之后它们没有别的落点。
    expect(
      within(chrome).getByRole("button", { name: /Language/i }),
    ).toBeTruthy();
    expect(within(chrome).getByRole("button", { name: /Theme/i })).toBeTruthy();
    // 「桌面端已连接」不在这条带上了：实时性收成账号块那一个出口，机器在线数由
    // 侧栏设备项的 2/3 与设备页说。
    expect(within(chrome).queryByText("Desktop connected")).toBeNull();
  });

  it("选中一条对话：那簇控件进详情头部的右端，右栏不再多叠一条带", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    renderChat();

    fireEvent.click(await screen.findByRole("link", { name: /重构登录页/ }));
    const slot = await screen.findByTestId("embedded-header-right");
    expect(
      within(slot).getByRole("button", { name: /Language/i }),
    ).toBeTruthy();
    expect(within(slot).queryByText("Desktop connected")).toBeNull();
    // 详情头部自己就是顶带，右栏不该再单画一条——那正是要消掉的那 52px。
    expect(screen.queryByTestId("chat-chrome")).toBeNull();
  });

  /**
   * 右栏的两种空：「一条都没有」和「有，只是还没选」不是同一句话。
   * 两支共用 chat.noSessions 时，左栏明明列着几条，右栏却说「还没有对话」。
   */
  it("有会话但还没选中:右栏说的是挑一条,不是「还没有对话」", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    renderChat();

    await screen.findByRole("link", { name: /重构登录页/ });
    const detail = screen.getByTestId("chat-detail");
    expect(within(detail).queryByText("No conversations yet.")).toBeNull();
    expect(within(detail).getByText("Pick a conversation")).toBeTruthy();
    // 「开始第一个对话」在已经有对话时同样不成立。
    expect(
      within(detail).queryByRole("button", {
        name: "Start your first conversation",
      }),
    ).toBeNull();
    expect(
      within(detail).getByRole("button", { name: "New conversation" }),
    ).toBeTruthy();
    // 真的空的时候仍旧说「还没有对话」(空态那条测试钉的是这一支)。
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
  });

  /**
   * 决策 9：行来自镜像。首屏因此不等中继，也不再有「关注名单只有指向」那条链路——
   * 三个旧请求（/v1/follows、逐台 session.list、cwd 探针）一个都不该再发。
   */
  it("行来自镜像：只问 /v1/agent-sessions，不问关注名单、不连中继、不上送 cwd 探针", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    renderChat();

    const link = await screen.findByRole("link", { name: /重构登录页/ });
    expect(link.getAttribute("href")).toBe("/devices/1/sessions/42");
    const paths = mockedApi.mock.calls.map((c) => c[0]);
    expect(paths.some((p) => p.startsWith("/v1/agent-sessions?"))).toBe(true);
    expect(paths).not.toContain("/v1/follows");
    expect(paths).not.toContain("/v1/workspace/session-projects");
    // 默认范围下不为了列一行去连任何一台机器（首屏不等中继）。
    expect(mockUseRelay).not.toHaveBeenCalled();
    expect(fakeClient.request).not.toHaveBeenCalled();

    // 点行:桌面右栏嵌入真实详情视图(deviceId/conversationId, form=embedded)。
    fireEvent.click(link);
    const embedded = await screen.findByTestId("embedded-session-detail");
    expect(embedded.getAttribute("data-device-id")).toBe("1");
    expect(embedded.getAttribute("data-session-id")).toBe("42");
    expect(embedded.getAttribute("data-form")).toBe("embedded");
    // 详情要按镜像的身份取历史（发起端指纹 + 会话标识），机器离线时那是唯一的
    // 来源；不传的话详情只能反过来去认领自己那一行，同号会话还可能认岔。
    expect(embedded.getAttribute("data-peer-fingerprint")).toBe("fp-1");
    expect(screen.getByRole("link", { name: "Chat" }).textContent).toBe("Chat");
    expect(screen.queryByText("Desktop connected")).toBeNull();
  });

  it("浏览器发起、agentred 承载的项目会话：按承载机器打开详情", async () => {
    stubApi({
      mirror: [
        mirrored({
          peer_fingerprint: "fp-web",
          machine_fingerprint: "fp-1",
          project_sync_id: "p-1",
          title: "从浏览器派发的会话",
        }),
      ],
      devices: [agentred],
      projects: [
        {
          sync_id: "p-1",
          name: "agentre-server",
          color: "agent-11",
          sort_order: 0,
        },
      ],
    });
    renderChat("/chat?axis=project");

    fireEvent.click(
      await screen.findByRole("link", { name: /从浏览器派发的会话/ }),
    );

    const embedded = await screen.findByTestId("embedded-session-detail");
    expect(embedded.getAttribute("data-device-id")).toBe("1");
    expect(embedded.getAttribute("data-session-id")).toBe("42");
    expect(embedded.getAttribute("data-peer-fingerprint")).toBe("fp-web");
  });

  /**
   * 本轮的主场景（决策 10）：执行机关掉之后，那条对话回到它该在的项目组里，
   * 标题 / 状态 / 归属一应俱全，「离线」退化成第二行末尾的一段字——不再是
   * 「暂时看不到」那一组里一条读不出标题、点不动的灰行。
   */
  it("机器离线时对话回到它该在的组里：标题/归属照常，只在第二行标离线，且点得进去", async () => {
    stubApi({
      mirror: [
        mirrored({
          peer_fingerprint: "fp-2",
          conversation_id: "7",
          title: "接口迁移的第二批",
          project_sync_id: "p-1",
        }),
      ],
      devices: [offlineMachine],
      projects: [
        {
          sync_id: "p-1",
          name: "agentre-server",
          color: "agent-11",
          sort_order: 0,
        },
      ],
    });
    renderChat();

    // 它在自己的项目组里，不在任何「暂时看不到」组里。
    expect(await screen.findByText("接口迁移的第二批")).toBeTruthy();
    expect(screen.getByText("agentre-server")).toBeTruthy();
    expect(screen.queryByText("Not visible right now")).toBeNull();
    // 第二行：机器名 + 离线。
    const second = screen.getByTestId("row-secondary-7");
    expect(second.textContent).toContain("公司 Mac mini");
    expect(second.textContent).toContain("Offline");
    // 行是可点的真链接（不是灰行）。
    const link = screen.getByRole("link", { name: /接口迁移的第二批/ });
    expect(link.getAttribute("href")).toBe("/devices/2/sessions/7");
    expect(link.getAttribute("aria-disabled")).toBeNull();
    // 离线机器不去连中继。
    expect(mockUseRelay).not.toHaveBeenCalled();
  });

  it("项目归属随摘要下来（决策 12）：project_sync_id 就是项目轴的组键，没有探针", async () => {
    stubApi({
      mirror: [mirrored({ project_sync_id: "p-1" })],
      devices: [agentred],
      projects: [
        {
          sync_id: "p-1",
          name: "agentre-server",
          color: "agent-11",
          sort_order: 0,
        },
      ],
    });
    renderChat();

    expect(await screen.findByText("agentre-server")).toBeTruthy();
    expect(screen.queryByText("Quick chats")).toBeNull();
    expect(
      mockedApi.mock.calls.some(
        (c) => c[0] === "/v1/workspace/session-projects",
      ),
    ).toBe(false);
  });

  it("判不出项目的会话进「随手对话」（决策 7：三个兜底组各自独立）", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    renderChat();

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(screen.getByText("Quick chats")).toBeTruthy();
  });

  it("行尾的时间是最后活动时间(last_message_at);老会话缺这一列时不猜一个时刻", async () => {
    const lastActive = 1754800000000;
    stubApi({
      mirror: [
        mirrored({ last_message_at: lastActive }),
        mirrored({
          conversation_id: "43",
          title: "老会话",
          last_message_at: 0,
        }),
      ],
      devices: [agentred],
    });
    renderChat();

    await screen.findByText("重构登录页");
    const shown = screen.getByText(formatRelativeTime(lastActive, "en"));
    expect(shown.getAttribute("datetime")).toBe(
      new Date(lastActive).toISOString(),
    );
    expect(document.querySelectorAll("time").length).toBe(1);
  });

  it("搜索把词交给服务端，行由服务端收窄，导航不混入对话计数", async () => {
    stubApi({
      devices: [agentred],
      index: (params) => {
        if (isWaitingProbe(params)) return { total: 0 };
        const q = params.get("q");
        const items = q
          ? [mirrored({ conversation_id: "43", title: "修 bug" })]
          : [mirrored(), mirrored({ conversation_id: "43", title: "修 bug" })];
        return {
          total: items.length,
          groups: [{ scope: "time", total: items.length, items }],
        };
      },
    });
    renderChat();

    await screen.findByText("重构登录页");
    const search = screen.getByRole("searchbox", {
      name: "Search conversations",
    });
    fireEvent.change(search, { target: { value: "修 bug" } });

    await waitFor(() => expect(lastIndexRequest().get("q")).toBe("修 bug"));
    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
    expect(screen.getByText("修 bug")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Chat" }).textContent).toBe("Chat");

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("重构登录页")).toBeTruthy());
  });

  it("搜索只按标题：机器名 / Agent 名 / 项目名不再参与匹配", async () => {
    stubApi({
      devices: [agentred],
      index: (params) => {
        if (isWaitingProbe(params)) return { total: 0 };
        // 服务端只按标题匹配（规格 2026-08-19 决策 8）：敲 Agent 名一条都不收。
        const q = params.get("q");
        const items = !q || "重构登录页".includes(q) ? [mirrored()] : [];
        return {
          total: items.length,
          groups: items.length
            ? [{ scope: "time", total: items.length, items }]
            : [],
        };
      },
      projects: [
        {
          sync_id: "p-1",
          name: "agentre-server",
          color: "agent-11",
          sort_order: 0,
        },
      ],
    });
    renderChat();
    await screen.findByText("重构登录页");
    const search = screen.getByRole("searchbox", {
      name: "Search conversations",
    });

    fireEvent.change(search, { target: { value: "后端 Agent" } });
    await waitFor(() =>
      expect(screen.getByTestId("session-index-empty")).toBeTruthy(),
    );
    // 空态说的是「这次搜索没有匹配」，不是「你还没有对话」。
    expect(screen.getByTestId("session-index-empty").textContent).toContain(
      "No conversations match your search",
    );

    fireEvent.change(search, { target: { value: "重构" } });
    await waitFor(() => expect(screen.getByText("重构登录页")).toBeTruthy());
  });
});

// 规格 2026-08-21：机器轴**一进来**就是每台在线机器此刻自己的清单——不再有
// 「在这台机器上找」那一层，也不再有 ?machine=。索引因此列出那些机器上有、账号里
// 还没保存的对话，行尾是「保存」（决策 11 的口径从「选中的那一台」扩到「每一台」）。
describe("对话页:机器轴", () => {
  const stranger = {
    ...summary,
    conversationId: "77",
    title: "临时跑一下 benchmark",
  };

  function stubMachineScope(over: Partial<{ mirror: unknown[] }> = {}) {
    stubApi({ mirror: over.mirror ?? [], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    // 关键词由**机器**筛（wire 的 SessionListRequest.keyword），假机器照做：
    // 客户端不再在收到之后重筛一遍，重筛会把机器按 agent 名 / 项目名命中的丢掉。
    fakeClient.request.mockImplementation(
      async (method: unknown, params: unknown) => {
        if (method !== rpcMethods.sessionList) {
          throw new Error("unexpected method: " + method);
        }
        const keyword = (params as { keyword?: string })?.keyword ?? "";
        const all = [summary, stranger];
        return {
          sessions: keyword
            ? all.filter((x) =>
                x.title.toLowerCase().includes(keyword.toLowerCase()),
              )
            : all,
        };
      },
    );
  }

  it("那台机器上有、账号里还没有的一同列出，行尾是「保存」", async () => {
    stubMachineScope({ mirror: [mirrored()] });
    renderChat("/chat?axis=machine");

    expect(await screen.findByText("临时跑一下 benchmark")).toBeTruthy();
    // 已经在账号里的那条只出现一次，且不摆保存。
    expect(screen.getAllByText("重构登录页").length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Save" }).length).toBe(1);
    // 挑一台机器这件事不再存在：它就是索引里的一个组。
    expect(screen.queryByTestId("machine-picker")).toBeNull();
  });

  /**
   * 这一条是本轮的主张本身：进机器轴**不用再点任何东西**，每台在线机器各自一组、
   * 各列各自此刻上报的那份。此前一次只看得见选中的那一台。
   */
  it("多台在线机器：各自一组，各列各自实时上报的那份", async () => {
    stubApi({ mirror: [], devices: [agentred, desktop] });
    relayByMachine({
      "fp-1": [{ ...summary, conversationId: "61", title: "小主机上跑着的" }],
      "fp-desktop": [
        {
          ...summary,
          conversationId: "62",
          peerFingerprint: "fp-desktop",
          title: "MacBook 上跑着的",
        },
      ],
    });
    renderChat("/chat?axis=machine");

    const box = await screen.findByTestId("group-device-1");
    expect(within(box).getByText("小主机上跑着的")).toBeTruthy();
    const laptop = screen.getByTestId("group-device-3");
    expect(within(laptop).getByText("MacBook 上跑着的")).toBeTruthy();
    // 两组各问各的机器，没有谁替谁答。
    expect(within(box).queryByText("MacBook 上跑着的")).toBeNull();
  });

  it("按下「保存」把这一条写进账号（POST /v1/saved-sessions），行随即变成账号里的一条", async () => {
    const posted: unknown[] = [];
    stubMachineScope({ mirror: [mirrored()] });
    const base = mockedApi.getMockImplementation()!;
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/saved-sessions" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return {};
      }
      return base(path, init);
    });
    renderChat("/chat?axis=machine");

    await screen.findByText("临时跑一下 benchmark");
    fireEvent.click(screen.getByTestId("row-save-77"));

    await waitFor(() =>
      expect(posted).toEqual([
        {
          machine_fingerprint: "fp-1",
          peer_fingerprint: "fp-1",
          conversation_id: "77",
        },
      ]),
    );
    // 保存之后它不再是「还没保存」的那种：行尾不再有保存。
    await waitFor(() => expect(screen.queryByTestId("row-save-77")).toBeNull());
  });

  /**
   * 那台机器上有一条**别人发起**的对话（从 web 控制台派出去的：执行端是这台机器，
   * 而 agentred 把它键在浏览器的中继标识下，session.list 照样报回来）。保存它时
   * 两个指纹必须分开报。
   *
   * 混作一谈的后果不是保存失败，而是保存**成功**、镜像却永远匹配不上它——账号里
   * 明明有，左栏一行都没有。所以这一条盯的是发出去的那份载荷，不是界面。
   */
  it("保存别的端发起、这台机器承载的那条:机器与发起端分开报", async () => {
    const posted: unknown[] = [];
    const fromBrowser = {
      ...summary,
      conversationId: "88",
      title: "从控制台开的",
      peerFingerprint: "991b9464868dfb6340bd09eeef14f196",
    };
    // 账号里先有一条：否则按下保存会先弹「内容会存在服务器上」那张说明，
    // 而这一条量的是载荷，不是那张说明。
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [fromBrowser] };
      throw new Error("unexpected method: " + method);
    });
    const base = mockedApi.getMockImplementation()!;
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/saved-sessions" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return {};
      }
      return base(path, init);
    });
    renderChat("/chat?axis=machine");

    await screen.findByText("从控制台开的");
    // 机器轴上行键带着那台机器（deviceId），因为同一条对话在两台机器上各有一份是常态。
    fireEvent.click(await screen.findByTestId("row-save-1:88"));

    await waitFor(() =>
      expect(posted).toEqual([
        {
          machine_fingerprint: "fp-1",
          peer_fingerprint: "991b9464868dfb6340bd09eeef14f196",
          conversation_id: "88",
        },
      ]),
    );
  });

  /**
   * 这一条盯的是**省略 origin 的语义**。`session.list` 只在「发起端不是调用方自己」
   * 时才交出 `peerFingerprint`（daemon 的 session_catchup.List：`row.PeerFingerprint
   * != peer` 才写）。所以从这个浏览器派发出去的对话，机器报回来的那份是**空的**，
   * 而它的账号身份是浏览器自己的中继标识（`relayTicket.clientId`）。
   *
   * 空 origin 兜底成「这台机器自己」的话，行键就变成 `<机器指纹>:<会话号>`，跟镜像里
   * 那条 `<浏览器标识>:<会话号>` 永远对不上：账号里明明保存了，机器轴上每一条都还
   * 挂着「保存」；按下去写进去的又是一条以机器指纹冒充发起端的假记录。
   */
  it("这台机器上、由本浏览器发起的那条:空 origin 认作本浏览器,已保存的不再摆「保存」", async () => {
    // 关键：机器报回来的这一条**不带** origin —— 它是从这个浏览器派出去的。
    const fromThisBrowser = {
      ...summary,
      conversationId: "99",
      peerFingerprint: undefined,
      title: "控制台开的",
    };
    stubApi({
      mirror: [
        mirrored({
          peer_fingerprint: "fp-web",
          machine_fingerprint: "fp-1",
          conversation_id: "99",
          title: "控制台开的",
        }),
      ],
      devices: [agentred],
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return { sessions: [fromThisBrowser] };
      throw new Error("unexpected method: " + method);
    });
    renderChat("/chat?axis=machine");

    await screen.findByText("控制台开的");
    // 账号里已经有它了：行尾不该再有「保存」。
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByTestId("row-save-99")).toBeNull();
  });

  it("离线的机器:组头在、标离线、一行都不列(规格 2026-08-19 决策 11)", async () => {
    stubApi({
      mirror: [
        mirrored({
          peer_fingerprint: "fp-2",
          conversation_id: "7",
          title: "离线那条",
        }),
      ],
      devices: [offlineMachine],
    });
    renderChat("/chat?axis=machine");

    // 这一档要回答的是「那台机器上有什么」，机器不在线时它答不出——列出镜像里的
    // 那些等于答了另一个问题。但机器本身仍要在列表上，并如实说它离线。
    const box = await screen.findByTestId("group-device-2");
    expect(within(box).getByText("公司 Mac mini")).toBeTruthy();
    expect(screen.getByTestId("group-offline-device-2")).toBeTruthy();
    expect(screen.queryByText("离线那条")).toBeNull();
    // 「你还没有对话」在这里是假话：账号里那些还在，只是这台机器答不出。
    expect(screen.queryByTestId("session-index-empty")).toBeNull();
    expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it("选中的机器在线:列的就是它上报的那份,镜像里它没有的那条不出现", async () => {
    stubMachineScope({
      mirror: [
        mirrored(),
        // 发起自这台机器、账号里还留着，但机器本地已经没有了的一条。
        mirrored({ conversation_id: "99", title: "机器上已经没有了" }),
      ],
    });
    renderChat("/chat?axis=machine");

    expect(await screen.findByText("临时跑一下 benchmark")).toBeTruthy();
    expect(screen.getByText("重构登录页")).toBeTruthy();
    expect(screen.queryByText("机器上已经没有了")).toBeNull();
  });

  // 搜索在这一档由机器自己做：整份拉回来再在浏览器里筛，机器上有几千条对话时就是
  // 几千份摘要过线，其中绝大多数与搜索无关。
  it("机器那一档的搜索下推给机器，回来的就是命中项", async () => {
    stubMachineScope({ mirror: [mirrored()] });
    renderChat("/chat?axis=machine");
    await screen.findByText("临时跑一下 benchmark");

    fireEvent.change(
      screen.getByRole("searchbox", {
        name: "Search conversations",
      }),
      { target: { value: "benchmark" } },
    );

    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
    expect(screen.getByText("临时跑一下 benchmark")).toBeTruthy();
  });

  it("机器那一档的 chips 也就地过滤这份清单(规格 2026-08-19 决策 12)", async () => {
    const running = {
      ...summary,
      conversationId: "78",
      title: "正在跑",
      lifecycleState: "running",
    };
    stubApi({ mirror: [], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async () => ({
      sessions: [summary, running],
    }));
    renderChat("/chat?axis=machine");
    await screen.findByText("正在跑");

    fireEvent.click(screen.getByTestId("filter-chip-running"));

    // 判据与镜像那几档逐字一致：「运行中」= running 且不等输入。
    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
    expect(screen.getByText("正在跑")).toBeTruthy();
  });

  // 「未读」在这一档有一条额外的判据：还没保存进账号的那些不算未读——它们压根
  // 不在你的账号里，「读没读过」无从谈起。机器上有、账号里没有的正是这一档的主角。
  it("机器那一档的「未读」不收还没保存进账号的那些", async () => {
    const onMachineOnly = {
      ...summary,
      conversationId: "78",
      title: "机器上才有的",
      updatedAt: 1754800000000,
    };
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async () => ({
      sessions: [summary, onMachineOnly],
    }));
    renderChat("/chat?axis=machine");
    await screen.findByText("机器上才有的");

    fireEvent.click(screen.getByTestId("filter-chip-unread"));

    await waitFor(() => expect(screen.queryByText("机器上才有的")).toBeNull());
    // 账号里那条从没打开过（last_read_at 缺省 0），所以它是未读的。
    expect(screen.getByText("重构登录页")).toBeTruthy();
  });

  // 已读那一半：账号里那条如果读过了（last_read_at 晚于最后活动），这一档也不该收。
  it("机器那一档的「未读」认账号里的 last_read_at，不是「有就算未读」", async () => {
    stubApi({
      mirror: [mirrored({ last_message_at: 1000, last_read_at: 2000 })],
      devices: [agentred],
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async () => ({
      sessions: [summary],
    }));
    renderChat("/chat?axis=machine");
    await screen.findByText("重构登录页");

    fireEvent.click(screen.getByTestId("filter-chip-unread"));

    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
  });

  it("机器上会话多时也先只列几条,其余走「查看全部 N」——N 是它上报的总数", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...summary,
      conversationId: String(100 + i),
      title: `机器上第 ${i} 条`,
    }));
    stubApi({ mirror: [], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async () => ({
      sessions: many,
    }));
    renderChat("/chat?axis=machine");

    expect(await screen.findByText("机器上第 0 条")).toBeTruthy();
    // 先只列几条：第 6 条之后的还在「查看全部」后面。
    expect(screen.queryByText("机器上第 7 条")).toBeNull();

    fireEvent.click(await screen.findByText("View all 8 sessions"));

    expect(await screen.findByText("机器上第 7 条")).toBeTruthy();
  });

  /**
   * 这一档的镜像行不再渲染，只用来标「已保存」与补项目归属（决策 8）：每组默认
   * 只回 5 条的话，一台机器上保存过第 6 条起就会被标成「还没保存」。
   */
  it("机器轴那一次镜像请求把每组条数提到服务端上限", async () => {
    stubMachineScope();
    renderChat("/chat?axis=machine");

    await screen.findByText("临时跑一下 benchmark");
    expect(lastIndexRequest().get("per_group")).toBe("50");
  });

  it("机器在线、清单还没回来:组头标「连接中」,不先编一句「还没有对话」", async () => {
    stubApi({ mirror: [], devices: [agentred] });
    const pending = {
      request: vi.fn(() => new Promise(() => {})),
      attach: vi.fn(async () => ({})),
      catchUp: vi.fn(async () => {}),
      close: vi.fn(),
    };
    mockUseRelay.mockReturnValue({
      ...connectedRelay(),
      client: pending as never,
    });
    renderChat("/chat?axis=machine");

    expect(await screen.findByTestId("group-state-device-1")).toBeTruthy();
    expect(
      screen.queryByText("No conversations on this machine yet."),
    ).toBeNull();
  });

  /**
   * 地址上不再有可选中的机器：`?machine=` 连同机器选择器一起下线（决策 5）。
   * 带着旧参数进来也不该退化成「只看那一台」——它就是被忽略。
   */
  it("地址上带着旧的 ?machine= 也照样列全部机器", async () => {
    stubApi({ mirror: [], devices: [agentred, desktop] });
    relayByMachine({
      "fp-1": [{ ...summary, conversationId: "61", title: "小主机上跑着的" }],
      "fp-desktop": [
        {
          ...summary,
          conversationId: "62",
          peerFingerprint: "fp-desktop",
          title: "MacBook 上跑着的",
        },
      ],
    });
    renderChat("/chat?axis=machine&machine=1");

    expect(await screen.findByText("小主机上跑着的")).toBeTruthy();
    expect(screen.getByText("MacBook 上跑着的")).toBeTruthy();
  });

  /**
   * 同一条对话会被**两台**机器同时报上来：daemon 按账号可见性列出别的对端发起的
   * 会话（`session.list` 的 accountWide 分支），并在那些条目上标出 origin 指纹，
   * 而发起的那台机器自己也照样报它。两行于是同属一条对话、分列两个组。
   *
   * 索引里的行键必须仍然一行一个：↑↓ 用 `findIndex(key)` 找光标、用
   * `[data-nav-target=key]` 送真焦点，两行同键的话两个都落在第一份上——光标卡在
   * 第一台机器那一行，↓ 再也走不到它下面的任何一行。
   */
  it("同一条对话被两台机器同时报上来:两行各是一行,↓ 走得过去", async () => {
    stubApi({ mirror: [], devices: [agentred, desktop] });
    relayByMachine({
      // 发起端是 MacBook，它自己报的那条不带 origin（「省略 = 调用方自己的对端」）。
      "fp-desktop": [
        {
          ...summary,
          conversationId: "88",
          peerFingerprint: "fp-desktop",
          title: "两台都在报的",
        },
      ],
      // 跑在小主机上，因此小主机也报它，并如实标出发起端。
      "fp-1": [
        {
          ...summary,
          conversationId: "88",
          title: "两台都在报的",
          peerFingerprint: "fp-desktop",
        },
      ],
    });
    renderChat("/chat?axis=machine");

    await waitFor(() =>
      expect(screen.getAllByText("两台都在报的").length).toBe(2),
    );
    const nav = screen.getByTestId("session-index-nav");
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    const first = document.activeElement;
    expect(first?.textContent).toContain("两台都在报的");

    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(first);
  });

  /**
   * 一台机器交出的清单只在**这条连接**上成立。离开这个轴时连接就关了（解析器
   * 卸载），再回来是一次新的连接：它开口之前这一组答不出「上面有什么」。
   *
   * 把上一次的那份留着顶，屏幕上就是一份没有任何东西为它背书的清单——期间那台
   * 机器上跑完的、新开的、被删掉的都不算数，而组头还说着「已连上」。
   */
  it("离开机器轴再回来:重新问过之前不拿上一次的清单顶着", async () => {
    stubApi({ mirror: [], devices: [agentred] });
    let asked = 0;
    mockUseRelay.mockReturnValue({
      ...connectedRelay(),
      client: {
        request: vi.fn((method: unknown) => {
          if (method !== rpcMethods.sessionList) {
            throw new Error("unexpected method: " + method);
          }
          asked += 1;
          // 回来那一次故意不答：这时组里该是「连接中」，不是上一次那份。
          return asked === 1
            ? Promise.resolve({
                sessions: [{ ...summary, title: "上一次问到的" }],
              })
            : new Promise(() => {});
        }),
        attach: vi.fn(async () => ({})),
        catchUp: vi.fn(async () => {}),
        close: vi.fn(),
      } as never,
    });
    renderChat("/chat?axis=machine");
    await screen.findByText("上一次问到的");

    fireEvent.pointerDown(screen.getByTestId("axis-picker"), { button: 0 });
    fireEvent.click(screen.getByTestId("axis-option-project"));
    await waitFor(() => expect(screen.queryByText("上一次问到的")).toBeNull());
    fireEvent.pointerDown(screen.getByTestId("axis-picker"), { button: 0 });
    fireEvent.click(screen.getByTestId("axis-option-machine"));

    await waitFor(() => expect(asked).toBe(2));
    expect(screen.getByTestId("group-state-device-1").textContent).toBe(
      "Connecting",
    );
    expect(screen.queryByText("上一次问到的")).toBeNull();
  });
});

/**
 * 隐私与承诺的变更：「保存」这个动作同时是同意的表达，因此这个账号**第一次**保存
 * 时要把「内容会存在 server 上」说清楚，而不是藏在一个图标里。
 */
describe("对话页:第一次保存时的说明", () => {
  const stranger = {
    ...summary,
    conversationId: "77",
    title: "临时跑一下 benchmark",
  };

  function stubFirstSave(mirror: unknown[], sessions: unknown[] = [stranger]) {
    stubApi({ mirror, devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async () => ({
      sessions,
    }));
    const base = mockedApi.getMockImplementation()!;
    const posted: unknown[] = [];
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/saved-sessions" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return {};
      }
      return base(path, init);
    });
    return posted;
  }

  it("账号里一条都还没保存过时:先弹说明,说清内容会存在服务器上,确认之后才真的保存", async () => {
    const posted = stubFirstSave([]);
    renderChat("/chat?axis=machine");

    await screen.findByText("临时跑一下 benchmark");
    fireEvent.click(screen.getByTestId("row-save-77"));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Save this conversation to your account?",
      }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("stored on AgentRe's server");
    // 说明弹出来的那一刻还没有写任何东西。
    expect(posted).toEqual([]);

    fireEvent.click(screen.getByTestId("first-save-confirm"));
    await waitFor(() =>
      expect(posted).toEqual([
        {
          machine_fingerprint: "fp-1",
          peer_fingerprint: "fp-1",
          conversation_id: "77",
        },
      ]),
    );
  });

  it("说明里取消 = 什么都不保存", async () => {
    const posted = stubFirstSave([]);
    renderChat("/chat?axis=machine");

    await screen.findByText("临时跑一下 benchmark");
    fireEvent.click(screen.getByTestId("row-save-77"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toEqual([]);
  });

  // 「第一次」的判据是账号里保存过几条，那个数在保存成功的那一刻就变了。不跟着动的
  // 话，同一次访问里每按一次「保存」都要再看一遍同意说明——第二条起它说的已经不是
  // 事实了（账号里明明已经有一条）。
  it("第一条存进去之后就不再是第一次:第二条直接保存,不再弹说明", async () => {
    const another = {
      ...stranger,
      conversationId: "78",
      title: "再来一条没保存的",
    };
    const posted = stubFirstSave([], [stranger, another]);
    renderChat("/chat?axis=machine");

    await screen.findByText("临时跑一下 benchmark");
    fireEvent.click(screen.getByTestId("row-save-77"));
    fireEvent.click(await screen.findByTestId("first-save-confirm"));
    await waitFor(() => expect(posted).toHaveLength(1));

    fireEvent.click(screen.getByTestId("row-save-78"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("账号里已经有保存过的对话时不再弹（说过一次就够了）", async () => {
    const posted = stubFirstSave([mirrored()]);
    renderChat("/chat?axis=machine");

    await screen.findByText("临时跑一下 benchmark");
    fireEvent.click(screen.getByTestId("row-save-77"));

    await waitFor(() =>
      expect(posted).toEqual([
        {
          machine_fingerprint: "fp-1",
          peer_fingerprint: "fp-1",
          conversation_id: "77",
        },
      ]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * 删除（决策 6 / 16）：行的右键菜单 → 一次确认 → 两边一起清。确认文案按执行机
 * 在线与否分两套；执行端是桌面端时说明被删掉的是那台电脑上这条对话本身。
 */
function stubDelete(over: Partial<{ mirror: unknown[]; devices: unknown[] }>) {
  stubApi({
    mirror: over.mirror ?? [mirrored()],
    devices: over.devices ?? [agentred],
  });
  const base = mockedApi.getMockImplementation()!;
  const posted: unknown[] = [];
  mockedApi.mockImplementation(async (path, init) => {
    if (path === "/v1/saved-sessions/delete" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return { peer_status: "deleted" };
    }
    return base(path, init);
  });
  return posted;
}

describe("对话页:删除一条对话", () => {
  it("机器在线:右键 → 确认里说清两边一起清 → 真的删,行随即消失", async () => {
    const posted = stubDelete({});
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.contextMenu(screen.getByText("重构登录页"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const body =
      (await screen.findByTestId("delete-session-body")).textContent ?? "";
    expect(body).toContain("书房小主机");
    expect(body).toContain("also deleted from");
    // 确认之前一个字都没写出去。
    expect(posted).toEqual([]);

    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    await waitFor(() =>
      // 只要身份：承载它的机器与发起端都由服务端自己查出来（决策 1）。
      expect(posted).toEqual([{ conversation_id: "42" }]),
    );
    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
  });

  it("删光之后回到「你还没有对话」，导航始终不带计数", async () => {
    stubDelete({});
    renderChat();

    await screen.findByText("重构登录页");
    expect(screen.getByRole("link", { name: "Chat" }).textContent).toBe("Chat");

    fireEvent.contextMenu(screen.getByText("重构登录页"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("delete-session-confirm"));

    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
    expect(screen.getByRole("link", { name: /Chat/ }).textContent).toBe("Chat");
    expect(screen.getByTestId("chat-empty-state")).toBeTruthy();
  });

  it("机器离线:确认里说的是「账号里当场删掉,那台机器下次上线时补删」", async () => {
    stubDelete({
      mirror: [mirrored({ peer_fingerprint: "fp-2", conversation_id: "7" })],
      devices: [offlineMachine],
    });
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.contextMenu(screen.getByText("重构登录页"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const body =
      (await screen.findByTestId("delete-session-body")).textContent ?? "";
    expect(body).toContain("公司 Mac mini");
    expect(body).toContain("is offline");
    expect(body).toContain("next time it comes online");
  });

  it("执行端是桌面端:确认里说明被删掉的是那台电脑上这条对话本身（决策 16）", async () => {
    stubDelete({
      mirror: [mirrored({ peer_fingerprint: "fp-desktop" })],
      devices: [desktop],
    });
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.contextMenu(screen.getByText("重构登录页"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const body =
      (await screen.findByTestId("delete-session-body")).textContent ?? "";
    expect(body).toContain("工作 MacBook");
    expect(body).toContain("the conversation itself on that computer");
  });

  it("删除没成功时不装作它没了:行还在,确认层留在原地", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    const base = mockedApi.getMockImplementation()!;
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/saved-sessions/delete") throw new Error("boom");
      return base(path, init);
    });
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.contextMenu(screen.getByText("重构登录页"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("delete-session-confirm"));

    await waitFor(() =>
      expect(
        (screen.getByTestId("delete-session-confirm") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.getByText("重构登录页")).toBeTruthy();
    expect(screen.getByTestId("delete-session-body")).toBeTruthy();
  });

  it("取消确认 = 什么都不删,行还在", async () => {
    const posted = stubDelete({});
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.contextMenu(screen.getByText("重构登录页"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await screen.findByTestId("delete-session-body");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByTestId("delete-session-body")).toBeNull(),
    );
    expect(posted).toEqual([]);
    expect(screen.getByText("重构登录页")).toBeTruthy();
  });
});

/**
 * 索引分页（规格 2026-08-19）：行、计数、搜索与筛选全部由服务端按当前轴给出。
 * 这一组守的是「浏览器不再自己在整份行上算」——那正是分页之后会悄悄变成半个谎的
 * 三件事。
 */
describe("索引按轴分页", () => {
  it("首屏按当前轴要组骨架，行来自 groups", async () => {
    stubApi({ devices: [agentred], mirror: [mirrored()] });
    renderChat("/chat?axis=agent");

    await screen.findByText("重构登录页");
    expect(lastIndexRequest().get("axis")).toBe("agent");
    expect(lastIndexRequest().get("scope")).toBeNull();
  });

  it("服务端 total 再大也不渲染到对话导航", async () => {
    stubApi({ devices: [agentred], mirror: [mirrored()], total: 137 });
    renderChat();

    await screen.findByText("重构登录页");
    expect(screen.getByRole("link", { name: "Chat" }).textContent).toBe("Chat");
  });

  it("搜索走服务端且只按标题：请求带 q，本地不再过滤", async () => {
    stubApi({ devices: [agentred], mirror: [mirrored()] });
    renderChat();
    await screen.findByText("重构登录页");

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "登录" },
    });

    await waitFor(() => expect(lastIndexRequest().get("q")).toBe("登录"));
    // 换了搜索词就是换了一个集合，位置必须回到起点
    expect(lastIndexRequest().get("cursor")).toBeNull();
  });

  it("筛选 chip 走服务端：请求带 filter", async () => {
    stubApi({ devices: [agentred], mirror: [mirrored()] });
    renderChat();
    await screen.findByText("重构登录页");

    fireEvent.click(screen.getByTestId("filter-chip-running"));

    await waitFor(() =>
      expect(lastIndexRequest().get("filter")).toBe("running"),
    );
  });

  it("时间轴滚到底取下一页并追加，不重复已有的行", async () => {
    stubApi({
      devices: [agentred],
      index: (params) => {
        if (isWaitingProbe(params)) return { total: 0 };
        return !params.get("cursor")
          ? {
              total: 2,
              groups: [
                {
                  scope: "time",
                  total: 2,
                  cursor: "1754800000000.1",
                  has_more: true,
                  items: [mirrored({ conversation_id: "42", title: "第一页" })],
                },
              ],
            }
          : {
              total: 2,
              cursor: "1754700000000.2",
              has_more: false,
              items: [mirrored({ conversation_id: "43", title: "第二页" })],
            };
      },
    });
    renderChat("/chat?axis=time");
    await screen.findByText("第一页");

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    await screen.findByText("第二页");
    expect(screen.getByText("第一页")).toBeTruthy();
    expect(lastIndexRequest().get("scope")).toBe("time");
    expect(lastIndexRequest().get("cursor")).toBe("1754800000000.1");
  });

  it("下一页失败时已列出的行留在原地，并给得出重试", async () => {
    stubApi({
      devices: [agentred],
      index: (params) => {
        if (isWaitingProbe(params)) return { total: 0 };
        if (!params.get("cursor")) {
          return {
            total: 2,
            groups: [
              {
                scope: "time",
                total: 2,
                cursor: "1754800000000.1",
                has_more: true,
                items: [mirrored({ title: "第一页" })],
              },
            ],
          };
        }
        throw new Error("boom");
      },
    });
    renderChat("/chat?axis=time");
    await screen.findByText("第一页");

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("第一页")).toBeTruthy();
  });
});

/**
 * 组的真数与按组翻页（规格 2026-08-19 决策 6）：N 由服务端给，点开之后按这一组的
 * scope 继续翻，范围参数一并带上。
 */
describe("索引：每组的真数与「查看全部 N」", () => {
  it("组头上的 N 来自服务端，点开按这一组的 scope 翻页且带上当前搜索", async () => {
    stubApi({
      devices: [agentred],
      index: (params) => {
        if (isWaitingProbe(params)) return { total: 0 };
        if (params.get("scope") === "agent:ag-1") {
          return {
            total: 9,
            has_more: false,
            items: [mirrored({ conversation_id: "44", title: "翻出来的" })],
          };
        }
        return {
          total: 9,
          groups: [
            {
              scope: "agent:ag-1",
              total: 9,
              items: [mirrored()],
            },
          ],
        };
      },
    });
    renderChat("/chat?axis=agent");
    await screen.findByText("重构登录页");

    fireEvent.click(await screen.findByText("View all 9 sessions"));

    expect(await screen.findByText("翻出来的")).toBeTruthy();
    expect(lastIndexRequest().get("scope")).toBe("agent:ag-1");
    expect(lastIndexRequest().get("axis")).toBe("agent");
  });
});

/**
 * 顶栏与搜索框（2026-08-20 对话页 UI/UX 改版）。
 *
 * 顶栏此前摆了三样东西，其中两样各自有问题：一个**没有标签的裸数字**（读者认不出
 * 它是「这个账号有几条对话」），和一颗「去设备上找对话」（它指向 /devices 再下钻，
 * 而机器轴就在这一页回答同一个问题）。对话总数放到导航项右侧容易被误读成未读数，
 * 因此顶栏和侧栏都不再渲染它。
 *
 * 搜索框的文案则是**过期**的：规格 2026-08-19 决策 8 把搜索收窄成只按标题，而
 * appShell.searchPlaceholder 还写着「搜索 Agent、设备、记录」——承诺的三样有两样
 * 已经搜不到了。
 */
describe("对话页：顶栏与搜索框", () => {
  it("顶栏和侧栏都不渲染对话总数", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    expect(screen.queryByTestId("chat-count")).toBeNull();
    expect(screen.getByRole("link", { name: "Chat" }).textContent).toBe("Chat");
  });

  it("删除的乐观覆盖层不会让导航出现计数", async () => {
    stubDelete({});
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    expect(screen.getByRole("link", { name: "Chat" }).textContent).toBe("Chat");

    fireEvent.contextMenu(screen.getByText("重构登录页"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("delete-session-confirm"));

    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
    expect(screen.getByRole("link", { name: "Chat" }).textContent).toBe("Chat");
  });

  it("顶栏不再摆「去设备上找对话」：机器轴就在这一页回答同一个问题", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    // 文案键 chat.findOnDevice 也一并删了（没有第二处用它），所以这里写死旧文案。
    expect(
      screen.queryByRole("link", {
        name: "Find conversations on your devices",
      }),
    ).toBeNull();
  });

  it("搜索框说的是「搜索会话」——搜索只按标题（决策 8），旧文案承诺的三样有两样搜不到", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    expect(
      screen.getByRole("searchbox", { name: "Search conversations" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("searchbox", {
        name: "Search agents, devices, and records",
      }),
    ).toBeNull();
  });
});

/**
 * 已读状态（2026-08-20 对话页 UI/UX 改版）。
 *
 * 「未读」此前不是一件真事：那一档叫过「未读」，判据却一直是 waitingForInput，
 * 规格 2026-08-17 决策 3 因此把名字改成了「等你处理」。现在它有了自己的列
 * （migration 202608200001 的 last_read_at），判据与桌面端 attention-store 的
 * lastMessageAt > lastReadAt 逐字一致。
 */
describe("对话页：未读", () => {
  it("第三个 chip 是「未读」，点了带 filter=unread 去服务端", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    const chip = screen.getByTestId("filter-chip-unread");
    expect(chip.textContent).toContain("Unread");
    fireEvent.click(chip);

    await waitFor(() =>
      expect(lastIndexRequest().get("filter")).toBe("unread"),
    );
  });

  it("chip 上那个数问的是完整集合下的未读数（不是这一页里数出来的）", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    await waitFor(() =>
      expect(
        indexRequests.some(
          (p) =>
            p.get("filter") === "unread" &&
            p.get("per_group") === "1" &&
            p.get("axis") === "time",
        ),
      ).toBe(true),
    );
  });

  /**
   * 「打开即已读」是**每次点进一条对话**都会走的那条路，因此它多发几条请求，代价
   * 是按点击次数算的。
   *
   * 服务端为此专门把新的已读时刻回给了客户端（MarkSessionReadResponse.last_read_at
   * 「供客户端就地覆盖那一行」），页面据此改自己手里那一行就够了——重取一遍索引
   * 拿回来的是同一份数据，只是多了两条请求（当前范围一条、完整集合上的未读数一条）。
   *
   * 这一条此前叫「详情确认标记已读后**立即重取索引**并清掉旧的未读数」：用户可见的
   * 那一半（未读数掉下来）原样留着，换掉的是它拿什么去兑现。
   */
  it("详情确认标记已读后就地清掉未读数，不再重取一遍索引", async () => {
    stubApi({
      mirror: [mirrored()],
      devices: [agentred],
      index: () => {
        const items = [mirrored()];
        return { total: 1, groups: [{ scope: "time", total: 1, items }] };
      },
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    expect(screen.getByTestId("filter-chip-unread").textContent).toContain("1");
    fireEvent.click(screen.getByText("重构登录页"));
    await screen.findByTestId("embedded-session-detail");

    // 服务端此后一直说「还有 1 条未读」：这一格掉下来只可能是就地改的，不可能是
    // 重取回来的。
    const before = indexRequests.length;
    fireEvent.click(screen.getByRole("button", { name: "marked-read" }));

    await waitFor(() =>
      expect(
        screen.getByTestId("filter-chip-unread").textContent,
      ).not.toContain("1"),
    );
    expect(indexRequests.length).toBe(before);
  });

  /**
   * 点一行进右栏时，索引取回来的**那一行**要整个递下去。
   *
   * 详情拿它当替补摘要（标题 / Agent 身份 / 离线时的模型那一格），此前是详情自己
   * 回头向服务端要一遍 `/v1/agent-sessions?conversation_id=`——一条纯重复的请求，而且
   * 头部要等它往返回来才认得出这是哪条对话。「详情拿到之后怎么用」由
   * session-detail.test.tsx 守，这里守的是宿主确实给了。
   */
  it("点一行进右栏：把索引取回来的那一整行递给详情", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.click(screen.getByText("重构登录页"));

    const detail = await screen.findByTestId("embedded-session-detail");
    expect(detail.getAttribute("data-initial-row")).toBe("42");
  });

  /**
   * 递给详情的 onMarkedRead 必须**引用恒定**。
   *
   * 真实详情把它列进了「session.list + attach + 按游标补齐」那条 effect 的依赖数组
   * （SessionDetailView 里那一处）。换一次引用，正开着的那条对话就重跑一遍那整套握手
   * ——而索引一收到镜像变更信号就会重取，也就是说对面每说一句话，这边正在读的这条
   * 对话都要重新 attach 一次。本轮是来省请求的，那样是反着加。
   *
   * 此前这个 prop 是 refetch（useCallback 空依赖，恒定），换成就地标记之后很容易
   * 顺手把行钉进依赖——这条就是钉住那件事的。
   */
  it("递给详情的已读回调引用恒定：索引重取不会让它重新 attach", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.click(screen.getByText("重构登录页"));
    await screen.findByTestId("embedded-session-detail");
    const first = markedReadProps.at(-1);
    expect(first).toBeTypeOf("function");

    // 别的端跑出来一条新消息：索引整份重取，行因此是全新的一批。
    const before = indexRequests.length;
    deliver(accountChannel.AccountChannelMirrorChanged);
    await waitFor(() => expect(indexRequests.length).toBeGreaterThan(before));

    expect(markedReadProps.at(-1)).toBe(first);
  });
});

/**
 * 项目设置弹窗读的必须是**重取回来的**项目，不是打开那一刻的快照
 * （规格 2026-08-20「项目上能改什么」：加/删一个成员之后，弹窗显示的是服务端
 * 确认过的状态）。快照的话，加完成员这一屏一动不动——用户看到的是「加不上」。
 */
describe("对话页：项目设置弹窗", () => {
  // jsdom 没有 scrollIntoView（真浏览器有）：focus 直落那一节要用它。
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  /** 项目树按当前成员现算，写成功之后重取到的就是新的那一份。 */
  function stubProjectApi() {
    let members: { sync_id: string; agent_sync_id: string }[] = [];
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/agent-sessions?")) {
        const items = [mirrored({ project_sync_id: "p-1" })];
        return {
          total: items.length,
          groups: [{ scope: "time", total: items.length, items }],
        };
      }
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      if (path.startsWith("/v1/workspace/projects/machines"))
        return { machines: [] };
      if (path === "/v1/workspace/projects")
        return {
          projects: [
            {
              sync_id: "p-1",
              name: "agentre-server",
              color: "agent-11",
              sort_order: 0,
              configured: true,
              members,
            },
          ],
        };
      if (path === "/v1/workspace/org/project-members") {
        members = [{ sync_id: "pa-1", agent_sync_id: "ag-1" }];
        return { sync_id: "pa-1", version: 1 };
      }
      throw new Error("unexpected: " + path);
    });
  }

  it("成员候选行上画的是那个 Agent 自己的图标，不是名字首字", async () => {
    // 桌面端的成员浮层与设置弹窗一直画图标（它把 avatarIcon 递进去），本站这一格
    // 从来没读过 avatar_icon —— 同一个 Agent 在两个宿主的同一处长成两个样子。
    stubProjectApi();
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("agentre-server");
    fireEvent.pointerDown(screen.getByTestId("project-menu-p-1"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByTestId("project-menu-item-settings"));
    fireEvent.click(await screen.findByTestId("project-member-add-open"));

    const candidate = await screen.findByTestId("project-member-add-ag-1");
    expect(
      within(candidate)
        .getByRole("img", { name: "后端 Agent" })
        .querySelector("svg")
        ?.getAttribute("class"),
    ).toContain("lucide-bot");
  });

  it("加一个成员之后，弹窗里的清单当场就变——它读的是重取回来的项目", async () => {
    stubProjectApi();
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("agentre-server");
    // ⋮ →「项目设置…」：Radix 的菜单开在 pointerdown 上。「成员…」那条深链已经
    // 并回设置（2026-08-27），成员这一节就在弹窗里。
    fireEvent.pointerDown(screen.getByTestId("project-menu-p-1"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByTestId("project-menu-item-settings"));

    // 候选收进了选人层：先把它打开。
    fireEvent.click(await screen.findByTestId("project-member-add-open"));
    fireEvent.click(await screen.findByTestId("project-member-add-ag-1"));
    // 加完之后这一行必须出现：它是「服务端确认过的状态」。
    expect(
      await screen.findByTestId("project-member-remove-pa-1"),
    ).toBeTruthy();
  });
});

/**
 * 子项目的 ＋ 要列出**继承自父项目**的成员（与桌面端 project-group-header.tsx
 * 同一条：直属 + 继承，继承那几条挂角标）。
 *
 * 此前这里只列 `project.members`，那是服务端如实回的**直接**成员——子项目自己没加
 * 过人时 ＋ 里是「这个项目还没有成员」，而同一个账号在「从项目里挑一个 Agent」那
 * 一屏（membersOfProject）却列得出父项目的 Agent。同一个产品两处口径不一致。
 */
describe("对话页：子项目的 ＋", () => {
  /** 父项目 p-1 有一个成员，子项目 p-2 一个都没加。 */
  function stubProjectTree() {
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/agent-sessions?")) {
        const items = [mirrored({ project_sync_id: "p-1" })];
        return {
          total: items.length,
          groups: [{ scope: "time", total: items.length, items }],
        };
      }
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents")
        return { agents: [{ ...agents[0], project_sync_ids: ["p-1"] }] };
      if (path.startsWith("/v1/workspace/projects/machines"))
        return { machines: [] };
      if (path === "/v1/workspace/projects")
        return {
          projects: [
            {
              sync_id: "p-1",
              name: "agentre-server",
              color: "agent-11",
              sort_order: 0,
              configured: true,
              members: [{ sync_id: "pa-1", agent_sync_id: "ag-1" }],
            },
            {
              sync_id: "p-2",
              name: "frontend",
              color: "agent-7",
              parent_sync_id: "p-1",
              sort_order: 1,
              configured: true,
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
  }

  it("继承来的那个成员点得到，且开出来的对话归子项目", async () => {
    stubProjectTree();
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    // 零对话的项目也出组头（规格 2026-08-21），子项目因此有自己的 ＋。
    await screen.findByText("frontend");
    /*
      这个子项目只继承到**一个**成员，所以 ＋ 直接开对话、不弹浮层（规格
      2026-08-22 决策 10：弹出来只是多一次点击，没有可选项）。「继承」那枚角标与
      两个以上时的浮层长相归共享包测，这里问的是本站独有的那一件事 ——
      递进去的是继承后的成员集，且开出来的草稿归**子项目**而不是成员来自的父项目。
    */
    fireEvent.click(screen.getByTestId("project-add-p-2"));

    const draft = await screen.findByTestId("draft-session");
    expect(
      within(draft).getByText(
        i18n.t("chat.startWithAgentInProject", {
          agent: "后端 Agent",
          project: "frontend",
        }),
      ),
    ).toBeTruthy();
  });
});

/**
 * Agent 轴的组头上那颗 ＋（共享包 6568f81d）。项目组头与「随手对话」组头一直有
 * ＋，Agent 组头没有——同一份索引里换一条轴，「在这一组里开一条」这个入口就没了，
 * 而桌面端 AgentGroup 上那颗一直在。
 */
describe("对话页：Agent 组头的 ＋", () => {
  it("点它直接开这个 Agent 的草稿，不必先绕一遍「挑一个 Agent」", async () => {
    stubApi({ mirror: [mirrored()] });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    await screen.findByText("重构登录页");
    fireEvent.pointerDown(screen.getByTestId("axis-picker"), { button: 0 });
    fireEvent.click(screen.getByTestId("axis-option-agent"));

    const header = screen
      .getAllByTestId("group-header")
      .find((el) => el.textContent?.includes("后端 Agent"));
    if (!header) throw new Error("Agent 轴上没有这个 Agent 的组头");
    fireEvent.click(within(header).getByTestId("group-header-plus"));

    // 落到的是草稿本身（compose 的 draft 档），不是「挑一个 Agent」那一屏。
    const draft = await screen.findByTestId("draft-session");
    expect(
      within(draft).getByText(
        i18n.t("chat.startWithAgent", { agent: "后端 Agent" }),
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("new-conversation-pane")).toBeNull();
  });
});

/**
 * 索引取不出来时不再顶掉整页（规格 2026-08-21 决策 14）。
 *
 * 此前是 `if (loadError) return <AppShell><Alert/></AppShell>`：侧栏还在，内容区
 * 一无所有，连个重试都没有，只能刷新浏览器。而失败的只是「列哪些行」这一件事。
 */
describe("对话页：索引取数失败", () => {
  /** /v1/agent-sessions 头一次失败，之后成功。 */
  function stubFailingIndex() {
    let failed = false;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/workspace/projects")) return { projects: [] };
      if (path.startsWith("/v1/agent-sessions?")) {
        indexRequests.push(new URLSearchParams(path.split("?")[1] ?? ""));
        if (!failed) {
          failed = true;
          throw new Error("boom");
        }
        return { total: 0, groups: [], unread: { total: 0 } };
      }
      throw new Error("unexpected: " + path);
    });
  }

  it("失败的只是「列哪些行」：轴选择器与筛选 chips 照常在,不是一块空白", async () => {
    stubFailingIndex();
    renderChat();

    expect(await screen.findByTestId("index-load-error")).toBeTruthy();
    expect(screen.getByTestId("index-filter-chips")).toBeTruthy();
  });

  it("带一个重试,按下去真的重新取一次", async () => {
    stubFailingIndex();
    renderChat();

    const banner = await screen.findByTestId("index-load-error");
    const before = indexRequests.length;
    await act(async () => {
      within(banner).getByRole("button").click();
    });
    await vi.waitFor(() => {
      expect(indexRequests.length).toBeGreaterThan(before);
    });
    // 取回来了就把横幅撤掉，不留一条已经不成立的错误。
    await vi.waitFor(() => {
      expect(screen.queryByTestId("index-load-error")).toBeNull();
    });
  });
});

/**
 * 首屏改骨架（规格 2026-08-21 决策 12）。
 *
 * 此前三处各一行 `common.loading`「加载中…」：左列、右栏、移动端。版面全空，
 * 数据回来时整列跳一次。
 */
describe("对话页：首屏", () => {
  it("还没取回来时列表位置是骨架,不是一行「加载中…」", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/workspace/projects")) return { projects: [] };
      if (path.startsWith("/v1/agent-sessions?")) {
        await held;
        return { total: 0, groups: [], unread: { total: 0 } };
      }
      throw new Error("unexpected: " + path);
    });

    renderChat();

    const skeleton = await screen.findByTestId("session-list-skeleton");
    // 纯装饰：正在取这件事由 aria-busy 说，几条灰条不必再念一遍。
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Loading…")).toBeNull();

    await act(async () => {
      release?.();
      await held;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("session-list-skeleton")).toBeNull();
    });
  });
});

/**
 * 规格 2026-08-21-root-project-entry 决策 1 / 3。
 *
 * 在此之前，能建项目的只有组头菜单的「新建子项目…」，它必定带一个父项目。
 * 控件行这一颗是**唯一**能建出顶层项目的地方——账号里一个项目都没有时，
 * 第一个项目也从这里建。
 */
describe("对话页：从控件行建顶层项目", () => {
  it("点它开的是不带父项目的新建弹窗", async () => {
    stubApi({
      projects: [
        { sync_id: "p-1", name: "后端", color: "agent-1", sort_order: 0 },
      ],
    });
    renderChat();

    fireEvent.click(await screen.findByTestId("index-new-project"));

    // 「New project」而不是「New project under 后端」：父项目为空。
    expect(await screen.findByText("New project")).toBeTruthy();
    expect(screen.queryByText(/New project under/)).toBeNull();
  });

  it("账号里一个项目都没有时它照样在：第一个项目就是从这里建的", async () => {
    stubApi({ projects: [] });
    renderChat();

    expect(await screen.findByTestId("index-new-project")).toBeTruthy();
  });
});

describe("对话页跟着通道走", () => {
  const listed = {
    peer_fingerprint: "fp-1",
    conversation_id: "1",
    title: "写个爬虫",
    lifecycle_state: "running",
    last_message_at: 1754000000000,
  };

  // 这一页是用户最容易撞见「没实时同步」的地方：会话索引此前只在范围（轴 / 搜索 /
  // 筛选）变化或本端派发之后才重取，别的端跑出来的新消息一律要刷新整页才看得到。
  it("镜像变更的信号一到，索引当场重取", async () => {
    stubApi({ devices: [agentred] });
    renderChat();
    await screen.findByTestId("session-index-empty");
    const before = indexRequests.length;

    stubApi({ devices: [agentred], mirror: [listed] });
    deliver(accountChannel.AccountChannelMirrorChanged);

    expect(await screen.findByText("写个爬虫")).toBeTruthy();
    expect(indexRequests.length).toBeGreaterThan(before);
  });

  // 行上的机器名与 Agent 名来自另外两份名单，它们各有各的信号来源。
  it("设备上线与同步版本推进各自重取自己那一份名单", async () => {
    stubApi({ devices: [] });
    renderChat();
    await screen.findByTestId("session-index-empty");
    mockedApi.mockClear();
    stubApi({ devices: [agentred] });

    deliver(accountChannel.AccountChannelDevicePresence);
    await waitFor(() =>
      expect(
        mockedApi.mock.calls.some(([p]) => String(p) === "/v1/devices"),
      ).toBe(true),
    );
    expect(
      mockedApi.mock.calls.some(([p]) =>
        String(p).startsWith("/v1/agent-sessions?"),
      ),
    ).toBe(false);

    mockedApi.mockClear();
    deliver(accountChannel.AccountChannelSyncVersion);
    await waitFor(() =>
      expect(
        mockedApi.mock.calls.some(
          ([p]) => String(p) === "/v1/workspace/agents",
        ),
      ).toBe(true),
    );
    expect(
      mockedApi.mock.calls.some(([p]) =>
        String(p).startsWith("/v1/agent-sessions?"),
      ),
    ).toBe(false);
  });
});

/**
 * 左栏的高亮说的是「右栏此刻开着哪一条」。
 *
 * 开「新对话」时右栏归 compose 那一路，没有任何一条对话开着；此时左栏还标着
 * 上一条的话，人会以为自己在往那条对话里写。派发之后右栏换成刚开的那一条，
 * 高亮也该跟着落到它身上。
 */
describe("对话页：左栏高亮跟着右栏走", () => {
  it("开「新对话」：上一条不再标成正开着的那一条", async () => {
    stubApi({ mirror: [mirrored()], devices: [agentred] });
    renderChat();

    fireEvent.click(await screen.findByRole("link", { name: /重构登录页/ }));
    await screen.findByTestId("embedded-session-detail");
    expect(
      screen
        .getByRole("link", { name: /重构登录页/ })
        .getAttribute("aria-current"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await screen.findByTestId("new-conversation-pane");

    expect(
      screen
        .getByRole("link", { name: /重构登录页/ })
        .getAttribute("aria-current"),
    ).toBeNull();
  });
});

/**
 * 左列可拖拽调宽（本轮 UI/UX）。
 *
 * 320px 对两类人都不对：只列着几条短标题的人希望它让位给转录，而按项目分组、
 * 标题写满一行的人在 320px 里读到的全是省略号。这是个人偏好，不是能挑出一个
 * 正确值的参数——所以交给拖，并且记住。
 *
 * 拖拽本身（document 级监听、量程封顶、抬起才落盘）是共享包 ResizableSidebar
 * 的行为，钉在那边的用例里。这里只钉**这一页接对了**：起点、量程、持久化 key，
 * 以及那条手柄真的在左列上。
 */
describe("对话页左列可调宽", () => {
  beforeEach(() => localStorage.removeItem("agentre.sidebarWidth.chat"));
  afterEach(() => localStorage.removeItem("agentre.sidebarWidth.chat"));

  it("左列是带拖拽手柄的 aside，没拖过时 320px", async () => {
    stubApi();
    renderChat();

    const listCol = screen.getByTestId("chat-list-col");
    expect(listCol.tagName).toBe("ASIDE");
    expect(listCol.style.width).toBe("320px");

    const handle = within(listCol).getByRole("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    // 量程要报得出来：拖到哪儿算到头，键盘/读屏用户不能只靠手感。
    expect(handle.getAttribute("aria-valuemin")).toBe("220");
    expect(handle.getAttribute("aria-valuemax")).toBe("640");
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
  });

  it("上次拖到的宽度还在——换一页回来不用重拖一次", async () => {
    localStorage.setItem("agentre.sidebarWidth.chat", "460");
    stubApi();
    renderChat();

    expect(screen.getByTestId("chat-list-col").style.width).toBe("460px");
  });

  it("存坏的值不当真：越界的记录按量程收回来", async () => {
    localStorage.setItem("agentre.sidebarWidth.chat", "9999");
    stubApi();
    renderChat();

    expect(screen.getByTestId("chat-list-col").style.width).toBe("640px");
  });
});
