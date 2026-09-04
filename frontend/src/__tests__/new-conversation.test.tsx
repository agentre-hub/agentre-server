/**
 * 从 web 发起新对话（R15 / R16 / R17，测试接缝 8 的 web 侧）。
 *
 * 形态是「挑一个 Agent → 一条还没发第一句的对话」，不再是三步弹层：
 *   - R15：派发计划按序逐档给出原因；一档都不可用时不静默失败，逐档摆出来。
 *   - R17：发起前就说明 org / subagent / hook 在这个目标下能不能用——不是等
 *     工具调用失败了才报错。
 *   - R16：派发成功后这条已进账号，直接去读它的实时流——桌面就地换右栏，
 *     移动端没有第二栏可落，才跳到会话页。
 *   - 「在哪台机器上跑」挑定一档后，计划必须**按那一档**重取（指纹与 cwd 只在
 *     chosen 上），挑中的档跑不了时不回落。
 *   - 还没发出去时左栏不多出任何一行：它还不是一条会话。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import {
  DispatchRunError,
  dispatchNewConversation,
  fetchDispatchPlan,
  type DispatchPlan,
} from "@/lib/dispatch";
import { readRecentAgents } from "@/lib/recentAgents";
import { ensureRelayTicket } from "@/lib/relayTicket";
import { RelayError } from "@/lib/relayClient";
import { useRelayMachine } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Chat from "@/pages/Chat";
import { NewConversationPane } from "@/components/session/newconv/NewConversationPane";
import { ProjectAgentPane } from "@/components/session/newconv/ProjectAgentPane";
import type {
  NewConvAgent,
  NewConvProject,
} from "@/components/session/newconv/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch")>();
  return {
    ...actual,
    fetchDispatchPlan: vi.fn(),
    dispatchNewConversation: vi.fn(),
  };
});
vi.mock("@/lib/relayTicket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayTicket")>();
  return { ...actual, ensureRelayTicket: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));
// 账号级实时通道自己要取一张票据（它就是靠票据接入的）。这个文件断言的是**挑
// Agent 那条路**不取票据，所以把通道挡在外面，别让它替被测的那条路背锅。
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);
const mockFetchPlan = vi.mocked(fetchDispatchPlan);
const mockDispatch = vi.mocked(dispatchNewConversation);
const mockEnsureRelayTicket = vi.mocked(ensureRelayTicket);
const mockUseRelay = vi.mocked(useRelayMachine);

const agents = [
  {
    sync_id: "agent-1",
    name: "Backend Agent",
    avatar_color: "agent-1",
    // Agent 自己选的图标键（共享包 org/icon-registry 的 key）。
    avatar_icon: "bot",
    project_sync_ids: ["proj-1"],
    has_available_target: true,
    exec_targets: [
      { rank: 1, availability: "no_device", is_local_reference: true },
      {
        rank: 2,
        device_name: "Study Mini",
        availability: "available",
        current: true,
      },
    ],
  },
  {
    sync_id: "agent-2",
    name: "Docs Agent",
    avatar_color: "agent-11",
    project_sync_ids: ["proj-root"],
    has_available_target: false,
    exec_targets: [
      { rank: 1, availability: "no_device", is_local_reference: true },
      { rank: 2, device_name: "Office Mac mini", availability: "offline" },
    ],
  },
];

const projects = [
  {
    sync_id: "proj-root",
    name: "agentre-server",
    color: "agent-1",
    configured: true,
    members: [],
  },
  {
    sync_id: "proj-1",
    name: "frontend",
    color: "agent-1",
    parent_sync_id: "proj-root",
    configured: true,
    members: [{ sync_id: "pa-1", agent_sync_id: "agent-1" }],
  },
];

const availablePlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    { rank: 1, availability: "no_device", current: false },
    {
      rank: 2,
      backend_sync_id: "b-a",
      device_id: 20,
      device_name: "Study Mini",
      backend_type: "claudecode",
      kind: "agentred",
      availability: "available",
      current: true,
    },
    {
      rank: 3,
      backend_sync_id: "b-b",
      device_id: 21,
      device_name: "MacBook Pro",
      backend_type: "codex",
      kind: "agentred",
      availability: "available",
      current: false,
    },
  ],
  chosen: {
    device_fingerprint: "fp-a",
    device_id: 20,
    device_name: "Study Mini",
    backend_type: "claudecode",
    kind: "agentred",
  },
  projects: [{ sync_id: "proj-1", name: "frontend", configured: true }],
};

const allUnavailablePlan: DispatchPlan = {
  agent_sync_id: "agent-2",
  tiers: [
    { rank: 1, availability: "no_device", current: false },
    { rank: 2, availability: "unpaired", current: false },
    {
      rank: 3,
      device_id: 21,
      device_name: "Office Mac mini",
      availability: "offline",
      current: false,
    },
  ],
  chosen: null,
  projects: [],
};

const relayTicket = {
  clientId: "fp-web",
  clientName: "Chrome · macOS",
  accessToken: "web-jwt",
  expiresAt: Date.now() + 120_000,
};

/** 账号里镜像着的一条真实会话（左栏据此列出一行）。 */
const mirroredSession = {
  peer_fingerprint: "fp-a",
  // 承载它的那台机器：索引行按这一维认设备（详情要连的就是它）。服务端从保存名单
  // 投影出来，每一条镜像行上都有。
  machine_fingerprint: "fp-a",
  conversation_id: "42",
  title: "重构登录页",
  agent_sync_id: "agent-1",
  backend_type: "claudecode",
  lifecycle_state: "idle",
  last_message_at: 1754800000000,
};

function stubReads(
  over: Record<string, unknown> = {},
  sessions: unknown[] = [],
) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/agent-sessions?"))
      return {
        total: sessions.length,
        groups: sessions.length
          ? [{ scope: "time", total: sessions.length, items: sessions }]
          : [],
      };
    // 设备名单与「账号里保存过几条对话」无关：派发计划里那台机器本来就在账号下，
    // 详情页要靠这一份认出承载它的是谁（认不出就整屏只剩一条「读不到设备」）。
    if (path === "/v1/devices")
      return {
        devices: [
          {
            id: 20,
            name: "Study Mini",
            kind: "agentred",
            fingerprint: "fp-a",
            online: true,
            status: 1,
          },
        ],
      };
    if (path.startsWith("/v1/workspace/agents")) return { agents };
    if (path.startsWith("/v1/workspace/projects")) return { projects };
    for (const [prefix, value] of Object.entries(over)) {
      if (path.startsWith(prefix)) return value;
    }
    throw new Error("unexpected: " + path);
  });
}

/** MemoryRouter 不碰 `window.location`，要读地址就得在 router 里问。 */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location-search">{location.search}</p>;
}

function renderChat(entry = "/chat") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ThemeProvider>
        <LocationProbe />
        <Routes>
          <Route path="/chat" element={<Chat />} />
          <Route
            path="/devices/:deviceId/sessions/:conversationId"
            element={<p>session page</p>}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** 走到「一条还没发第一句的对话」：点空态主动作 → 挑第一个 Agent。 */
async function openDraft() {
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Start your first conversation",
    }),
  );
  fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
  return screen.findByTestId("draft-session");
}

/**
 * 草稿里的输入框就是共享包的 `AIChatInput`（TipTap），驱动方式与会话详情那边
 * 一模一样：`fireEvent.change` / `.value` 都对它不成立，从 `editor.view.dom.editor`
 * 上驱动（理由见 session-detail.test.tsx 的同名注释）。
 */
function draftEditable(): HTMLElement & {
  editor?: { commands: { setContent: (v: string) => void } };
} {
  const el = document.querySelector<HTMLElement>(
    '[data-testid="session-detail-composer"] .ProseMirror',
  );
  if (!el) throw new Error("输入框没渲染出来");
  return el;
}

/** 等输入框那一 chunk 加载完（它是动态 import 切出去的）。 */
async function awaitDraftComposer() {
  await vi.waitFor(() => draftEditable());
}

async function typeInDraft(text: string) {
  await awaitDraftComposer();
  draftEditable().editor?.commands.setContent(`<p>${text}</p>`);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  mockedApi.mockReset();
  mockFetchPlan.mockReset();
  mockDispatch.mockReset();
  mockEnsureRelayTicket.mockReset();
  mockUseRelay.mockReset();
  mockUseRelay.mockReturnValue({
    client: null,
    relayState: "disconnected",
    relayTicket: null,
    relayTicketError: null,
    reconnect: vi.fn(),
  });
});

/**
 * 「新建一个会话」这个出口从别处进来时的落点。
 *
 * 会话详情的「机器离线」横幅给的就是这一个出口（两端统一）：那条对话钉在一台
 * 够不着的机器上，续轮不会改派，唯一走得通的路是另起一条。详情在路由页形态下
 * 不在 `/chat` 里，所以它靠 URL 说这件事，而不是靠一个跨页面的回调。
 */
describe("从别处进来的「新建一个会话」", () => {
  it("Given /chat?compose=1, When 进页面, Then 直接停在挑 Agent 那一屏", async () => {
    stubReads();
    renderChat("/chat?compose=1");

    expect(await screen.findByTestId("agent-pick-agent-1")).toBeTruthy();
  });

  it("Given 已经开了, When 看地址, Then compose 参数已经消掉", async () => {
    // 留着的话，之后每一次刷新 / 前进后退都会把人重新丢回挑 Agent 那一屏——
    // 它说的是「刚才要新建」这件一次性的事，不是页面此刻的范围。
    stubReads();
    renderChat("/chat?compose=1&axis=project");

    await screen.findByTestId("agent-pick-agent-1");
    await vi.waitFor(() => {
      const search = screen.getByTestId("location-search").textContent ?? "";
      expect(search).not.toContain("compose");
      // 别把同一屏别的范围一起冲掉：轴是页面此刻的范围，不是一次性的意图。
      expect(search).toContain("axis=project");
    });
  });
});

/**
 * 「还没取到」不是「一个都没有」。
 *
 * `/v1/workspace/agents` 是页面挂载时才发的一次请求，而 `agents` 的初值是空数组
 * ——`/chat?compose=1` 直接落在挑 Agent 那一屏（会话详情「机器离线」横幅给的正是
 * 这个出口），于是那一个往返里屏幕上写的是「账号里还没有 Agent，去桌面端建一个」。
 * 那句话是**肯定的**，而此刻还没有任何依据说它。
 *
 * 与「切对话闪红横幅」「切机器摆旧机器状态」是同一类错：瞬态被说成了终态。这一档
 * 的正确表达是骨架——占住位置、说「在来」，不说任何一句可能是假的话。
 */
describe("挑 Agent：清单还在路上时不谎报「一个都没有」", () => {
  it("Given Agent 清单还没回来, When 停在挑 Agent 那一屏, Then 摆骨架而不是空态", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, groups: [] };
      if (path === "/v1/devices") return { devices: [] };
      // 这一次永不落定：这就是「还没取到」的那一段。
      if (path.startsWith("/v1/workspace/agents")) return new Promise(() => {});
      if (path.startsWith("/v1/workspace/projects")) return { projects: [] };
      throw new Error("unexpected: " + path);
    });

    renderChat("/chat?compose=1");

    await screen.findByTestId("new-conversation-pane");
    expect(screen.queryByTestId("agent-pick-empty")).toBeNull();
    expect(screen.getByTestId("agent-pick-skeleton")).toBeTruthy();
  });
});

describe("挑一个 Agent", () => {
  it("跑不了的 Agent 摆出来但点不动，且行尾说清楚为什么", async () => {
    stubReads();
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );

    const blocked = await screen.findByTestId("agent-pick-agent-2");
    expect(blocked.hasAttribute("disabled")).toBe(true);
    // 「本机」那一档在网页语境下永远跳过，拿它当理由等于什么都没说——
    // 要给的是第一档**说得出原因**的。
    expect(
      screen.getByTestId("agent-pick-agent-2-target").textContent,
    ).toContain("Office Mac mini");
    expect(
      screen.getByTestId("agent-pick-agent-2-target").textContent,
    ).toContain("Offline");

    fireEvent.click(blocked);
    expect(screen.queryByTestId("draft-session")).toBeNull();
  });

  it("Agent 选过图标时清单里画的是那一枚，不是名字首字母", async () => {
    stubReads();
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );

    const row = await screen.findByTestId("agent-pick-agent-1");
    expect(
      within(row)
        .getByRole("img", { name: "Backend Agent" })
        .querySelector("svg")
        ?.getAttribute("class"),
    ).toContain("lucide-bot");
  });

  it("只取一次光杆 Agent 清单，不为此把这台浏览器注册成设备", async () => {
    stubReads();
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );
    await screen.findByTestId("agent-pick-agent-1");
    expect(
      mockedApi.mock.calls.some(([path]) => path === "/v1/workspace/agents"),
    ).toBe(true);
    expect(mockEnsureRelayTicket).not.toHaveBeenCalled();
  });
});

describe("一条还没发第一句的对话", () => {
  it("摆出「将在 X 上运行」，而且左栏不多出任何一行", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();
    await openDraft();

    expect(
      (await screen.findByTestId("draft-exec-target")).textContent,
    ).toContain("Study Mini");
    // 还没发出去 = 还不是一条会话：列表里不该凭空多一行。
    //
    // 盯的是**会话行**（行是链接，带 data-nav-target），不是组头：项目轴的组头
    // 来自账号的项目名单，与有没有会话无关，一条对话都没有时它照样在
    // （规格 2026-08-21-root-project-entry 决策 4）。拿 `group-` 当「列表是空的」
    // 的替身，量的就不再是这条用例要说的那件事。
    expect(screen.queryByTestId("draft-session")).toBeTruthy();
    expect(document.querySelectorAll("[data-nav-target]")).toHaveLength(0);
    expect(screen.getByTestId("session-index-empty")).toBeTruthy();
  });

  it("没打字时发不出去；打了字发出去 → 派发、记住这个 Agent、就地进入这条新会话", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: true,
      reasoningEffortPinned: true,
    });
    renderChat();
    await openDraft();

    await awaitDraftComposer();
    const send = screen.getByTestId("session-detail-send");
    expect(send.hasAttribute("disabled")).toBe(true);

    await typeInDraft("跑一下失败的测试");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(mockDispatch.mock.calls[0][0].message).toBe("跑一下失败的测试");
    // 桌面端**不换页**：挑 Agent / 选项目 / 草稿这三步都在右栏里走完，最后一步
    // 却把整个两栏掀掉的话，左栏那份上下文凭空没了。落地形态与「点左栏一条已有
    // 对话」同一套：右栏就地换成这条新会话的真实详情。
    expect(await screen.findByTestId("session-detail-view")).toBeTruthy();
    expect(screen.queryByText("session page")).toBeNull();
    expect(screen.getByTestId("chat-detail")).toBeTruthy();
    // 「最近用过」记在派发成功之后。
    expect(readRecentAgents()).toEqual(["agent-1"]);
  });

  /**
   * 派发在飞的那一小段，屏幕上该是**这条对话已经开始了**的样子：自己刚说的那句话
   * 落进转录、下面转着三个点 —— 与桌面端 `doSend` 同时插入 user + assistant 占位
   * 之后的形态一致，也与紧接着落地的会话详情连得上（同一批组件、同一个位置）。
   *
   * 此前这里是空态原样留着、底下补一行小字「Starting…」：用户刚敲下回车，输入框
   * 已经被清空，而屏幕上一个字都没有他刚说的那句话 —— 唯一的反馈是一行会消失的
   * 状态文案，跟桌面端不是一回事。
   */
  it("派发在飞：自己那句话落进转录，三点转起来，不再是一行「Starting…」", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    // 派发一直在飞：这条用例量的就是「在飞的那一段」长什么样。
    mockDispatch.mockImplementation(() => new Promise(() => {}));
    renderChat();
    await openDraft();

    await typeInDraft("跑一下失败的测试");
    await waitFor(() =>
      expect(
        screen.getByTestId("session-detail-send").hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("session-detail-send"));

    // 顶带的标题这一刻也换成了这一句（同一个 deriveTitle），所以按转录那一段找。
    const pending = await screen.findByTestId("draft-pending");
    expect(within(pending).getByText("跑一下失败的测试")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Generating" })).toBeTruthy();
    expect(screen.queryByText("Starting…")).toBeNull();

    const avatars = pending.querySelectorAll('[role="img"]');
    expect(avatars).toHaveLength(2);
    expect(avatars[0].className).toContain("size-7");
    expect(avatars[1].className).toContain("size-7");
  });

  /**
   * 右栏进了新会话、左栏却列不出它，等于告诉用户「这条不在你账号里」——而
   * `dispatchNewConversation` 派发成功后就已经把它写进 /v1/saved-sessions 了。
   * 因此这一刻要重取一次索引，让它作为一行落到左栏里。
   */
  it("派发成功后重取索引：新会话作为一行落进左栏", async () => {
    const listed: unknown[] = [];
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: listed.length,
          groups: listed.length
            ? [{ scope: "time", total: listed.length, items: listed }]
            : [],
        };
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 20,
              name: "Study Mini",
              kind: "agentred",
              fingerprint: "fp-a",
              online: true,
              status: 1,
            },
          ],
        };
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      if (path.startsWith("/v1/workspace/projects")) return { projects };
      throw new Error("unexpected: " + path);
    });
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockImplementation(async () => {
      // 派发成功 = 那台机器上真多了一条会话，并已保存进账号：下一次取索引
      // 才有这一行。
      listed.push({
        ...mirroredSession,
        conversation_id: "99",
        title: "跑一下失败的测试",
      });
      return {
        conversationId: "99",
        deviceId: 20,
        deviceFingerprint: "fp-a",
        peerFingerprint: "fp-web",
        title: "跑一下失败的测试",
        userText: "跑一下失败的测试",
        modelPinned: true,
        reasoningEffortPinned: true,
      };
    });
    renderChat();
    await openDraft();

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("link", { name: /跑一下失败的测试/ }),
    ).toBeTruthy();
  });

  // 用户的原话是「直接进入空白的对话框，让用户自己输入，和桌面端交互一样」。
  // 第一句和第二句用两个不同的输入框，就不是同一个交互：一个有 @ 提及 / 斜杠
  // 命令 / 快捷键提示，另一个是裸 textarea。
  it("第一句用的就是后续消息那个输入框，不是另做一个", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    expect(screen.getByText("↵ Send · ⇧↵ New line")).toBeTruthy();
    expect(screen.queryByTestId("draft-composer")).toBeNull();
  });

  it("空白对话框不展示预设的快捷开头", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    expect(screen.queryByText("Explain this project")).toBeNull();
    expect(screen.queryByText("Look at the failing test")).toBeNull();
    expect(screen.queryByText("Continue the last migration")).toBeNull();
  });

  it("派发失败时不记「最近用过」——开不起来的那次不算用过", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockRejectedValue(new Error("relay down"));
    renderChat();
    await openDraft();

    await typeInDraft("hi");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalled());
    expect(readRecentAgents()).toEqual([]);
  });

  it("计划取不到时不谎称「没有可用的执行目标」，并给一条重试", async () => {
    stubReads();
    let calls = 0;
    mockFetchPlan.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("plan unavailable");
      return availablePlan;
    });
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    renderChat();
    await openDraft();

    // 「这次没问到计划」和「问到了，一档都不可用」是两件事。此前 planError 落到
    // 最后一支，输入框下沿写的是后者——一句此刻无从证实的话。
    const failed = await screen.findByTestId("draft-plan-failed");
    await waitFor(() =>
      expect(screen.queryByText("No available execution target")).toBeNull(),
    );

    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.queryByTestId("draft-plan-failed")).toBeNull();
  });

  it("派发失败时用户那句话还回输入框，不随占位一起消失", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockRejectedValue(new Error("relay down"));
    renderChat();
    await openDraft();

    await typeInDraft(
      "把登录页的按钮改成蓝色，另外顺手把那个 flaky 的用例修了",
    );
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    // 提交那一刻输入框已被清空，唯一显示这句话的是派发占位；失败时占位跟着卸载，
    // 屏幕上只剩一行红字，用户写的整段话就没了。SendFailureBubble 立的规矩正相反：
    // 用户写的字要留在屏幕上，复制得走。
    await waitFor(() => expect(mockDispatch).toHaveBeenCalled());
    await waitFor(() =>
      expect(draftEditable().textContent).toContain(
        "把登录页的按钮改成蓝色，另外顺手把那个 flaky 的用例修了",
      ),
    );
  });

  it("Given coding 已连接但远端 CLI 启动失败, When 发第一句, Then 展示远端错误而不是误报连不上", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockRejectedValue(
      new DispatchRunError(
        new RelayError(
          -32603,
          'exec: "claude": executable file not found in $PATH',
        ),
      ),
    );
    renderChat();
    await openDraft();

    await typeInDraft("检查一下");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Study Mini is connected");
    expect(alert.textContent).toContain(
      'exec: "claude": executable file not found in $PATH',
    );
    expect(alert.textContent).not.toContain("Could not reach Study Mini");
  });
});

describe("在哪台机器上跑", () => {
  it("挑定一档后按那一档重取计划（指纹与 cwd 只在 chosen 上）", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();
    await openDraft();

    fireEvent.click(await screen.findByTestId("draft-exec-target-chip"));
    fireEvent.click(await screen.findByTestId("draft-tier-3"));

    await waitFor(() =>
      expect(mockFetchPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSyncId: "agent-1",
          targetBackendSyncId: "b-b",
        }),
      ),
    );
  });

  it("挑定的那一档跑不了时不回落到自动挑，给的是「交回自动挑」", async () => {
    stubReads();
    mockFetchPlan.mockImplementation(async (input) =>
      input.targetBackendSyncId === "b-b"
        ? { ...availablePlan, chosen: null }
        : availablePlan,
    );
    renderChat();
    await openDraft();

    fireEvent.click(await screen.findByTestId("draft-exec-target-chip"));
    fireEvent.click(await screen.findByTestId("draft-tier-3"));

    expect(
      await screen.findByTestId("draft-picked-target-unavailable"),
    ).toBeTruthy();
    // 没有悄悄换一台去跑：那一行不该又冒出来说「将在 Study Mini 上运行」。
    expect(screen.queryByTestId("draft-exec-target")).toBeNull();

    fireEvent.click(screen.getByTestId("draft-use-auto-target"));
    expect(await screen.findByTestId("draft-exec-target")).toBeTruthy();
  });

  it("一档都不可用时逐档给原因，而不是静默失败", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(allUnavailablePlan);
    renderChat();
    await openDraft();

    const block = await screen.findByTestId("draft-all-unavailable");
    expect(block.textContent).toContain("Not paired");
    expect(block.textContent).toContain("Offline");
    expect(block.textContent).toContain("No device set");
  });
});

describe("在哪个项目里跑", () => {
  it("默认不指定项目；挑了项目就带着它重取计划，标题也跟着说", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();
    await openDraft();

    expect(
      (await screen.findByTestId("draft-project-chip")).textContent,
    ).toContain("No project");

    fireEvent.click(screen.getByTestId("draft-project-chip"));
    fireEvent.click(await screen.findByTestId("draft-project-proj-1"));

    await waitFor(() =>
      expect(mockFetchPlan).toHaveBeenCalledWith(
        expect.objectContaining({ projectSyncId: "proj-1" }),
      ),
    );
    expect(
      await screen.findByText(/Start a project conversation with/),
    ).toBeTruthy();
  });

  /**
   * 换项目只是**重算一遍计划**，不是换一条对话。
   *
   * 此前重算期间 `plan` 整个落回 null，而这一屏底下每一样都挂在它上面：执行目标
   * 那一行、项目 chip、模型 / 档位 / 力度三颗控件一起卸掉，中继连的那台机器也跟着
   * 变 null —— 一次往返里整个右栏拆了重搭，连接也白断一次（换项目根本不换机器）。
   */
  it("重算计划时右栏不拆：那一行、chip 与控件都留在原地，中继也不断开", async () => {
    stubReads();
    let releaseSecond: ((plan: DispatchPlan) => void) | null = null;
    let calls = 0;
    mockFetchPlan.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return availablePlan;
      // 第二次一直在飞：这条用例量的就是「在飞的那一段」右栏长什么样。
      return new Promise<DispatchPlan>((resolve) => {
        releaseSecond = resolve;
      });
    });
    renderChat();
    await openDraft();
    await screen.findByTestId("draft-exec-target");
    await awaitDraftComposer();
    const machineBefore = mockUseRelay.mock.calls.at(-1)?.[0];

    fireEvent.click(screen.getByTestId("draft-project-chip"));
    fireEvent.click(await screen.findByTestId("draft-project-proj-1"));
    await waitFor(() => expect(calls).toBe(2));

    expect(screen.queryByTestId("draft-exec-target")).toBeTruthy();
    // chip 上已经是新挑的那个项目：它是本地选择，不必等计划回来。
    expect(screen.getByTestId("draft-project-chip").textContent).toContain(
      "frontend",
    );
    expect(screen.queryByTestId("composer-model-target")).toBeTruthy();
    // 换的是项目不是机器：这条连接没有任何理由断一次再连回来。
    expect(mockUseRelay.mock.calls.at(-1)?.[0]).toBe(machineBefore);
    expect(releaseSecond).toBeTruthy();
  });
});

describe("从项目里挑一个 Agent", () => {
  it("直接成员与继承自父项目分成两组", async () => {
    stubReads();
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );
    fireEvent.click(await screen.findByTestId("new-conversation-from-project"));

    // 树按父在前：默认停在根项目 agentre-server，它的直接成员是 Docs Agent。
    expect(await screen.findByTestId("project-members-direct")).toBeTruthy();
    expect(screen.getByTestId("project-agent-agent-2")).toBeTruthy();

    // 换到子项目 frontend：Backend Agent 是直接成员，Docs Agent 从父项目继承。
    fireEvent.click(screen.getByTestId("project-node-proj-1"));
    expect(await screen.findByTestId("project-agent-agent-1")).toBeTruthy();
    expect(screen.getByTestId("project-members-inherited")).toBeTruthy();
  });

  /**
   * 一个项目都还没有时，右边那一半此前照样摆着「这个项目里还没有 Agent」——而根本
   * 没有「这个项目」：左边写着「还没有项目」，右边同时在谈论一个不存在的项目。
   * 两句话一起出现，用户读到的是「有个项目，只是空的」，于是去找那个项目。
   *
   * 空态要说的是真话：一个项目都没有，并且说清楚该去哪儿建。
   */
  it("一个项目都没有时:不谈论不存在的项目,并指出去哪儿建", async () => {
    stubReads();
    // stubReads 的 over 只兜住它自己没答的路径，项目那一条它先答了：这一条要的正是
    // 「一个项目都没有」，所以把那一路单独盖掉。
    const base = mockedApi.getMockImplementation()!;
    mockedApi.mockImplementation(async (path, init) =>
      path.startsWith("/v1/workspace/projects")
        ? { projects: [] }
        : base(path, init),
    );
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );
    fireEvent.click(await screen.findByTestId("new-conversation-from-project"));

    await screen.findByTestId("project-agent-pane");
    expect(screen.queryByTestId("project-agents-empty")).toBeNull();
    expect(screen.getByTestId("project-none-yet")).toBeTruthy();
  });

  it("从项目里挑中一个照样进那条还没发第一句的对话", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );
    fireEvent.click(await screen.findByTestId("new-conversation-from-project"));
    fireEvent.click(screen.getByTestId("project-node-proj-1"));
    fireEvent.click(await screen.findByTestId("project-agent-agent-1"));

    expect(await screen.findByTestId("draft-session")).toBeTruthy();
  });
});

/**
 * 「挑一个 Agent」的三种空，与会话索引空态同一条判据（`session-index.test.tsx`
 * 「空态与失败的出路」）：说清楚**什么**空了、外面还有什么、给一条回程。
 *
 * 此前这一格是一行 14px 灰字，而且账号里没有 Agent 时借的是**总览页**的
 * `overview.empty`。借键有两个后果：总览改一句文案会连带改这里；总览删/改名时
 * 这里不报错，只在运行时把裸键号印到界面上（`sessionIndex.search.empty` 已经
 * 这样咬过一次）。
 */
describe("挑一个 Agent：空的时候说什么", () => {
  const agent: NewConvAgent = {
    sync_id: "a-1",
    name: "Reviewer",
    has_available_target: true,
    exec_targets: [
      { rank: 1, availability: "available", current: true, device_name: "box" },
    ],
  };

  function renderPane(agents: NewConvAgent[]) {
    return render(
      <ThemeProvider>
        <NewConversationPane
          agents={agents}
          recentIds={[]}
          onPick={vi.fn()}
          onFromProject={vi.fn()}
        />
      </ThemeProvider>,
    );
  }

  it("账号里一个 Agent 都没有：这一句归自己，不借总览页的键", () => {
    renderPane([]);

    const empty = screen.getByTestId("agent-pick-empty");
    expect(empty.textContent).not.toContain("overview.");
    expect(empty.textContent).not.toContain("chat.");
    // 只说「还没有 Agent」是半句：得说清楚它们从哪来，否则读者不知道下一步。
    expect(empty.textContent).toContain("desktop");
  });

  it("搜索搜空了：说的是这次搜索,并给一条清除搜索的回程", () => {
    renderPane([agent]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), {
      target: { value: "zzz" },
    });

    const empty = screen.getByTestId("agent-pick-empty");
    expect(empty.textContent).toContain("No agents match your search");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    // 清完之后清单回来了，空态收走。
    expect(screen.queryByTestId("agent-pick-empty")).toBeNull();
    expect(screen.getByText("Reviewer")).toBeTruthy();
  });
});

/**
 * 「从项目里挑一个」的两种空与上面同一条。它们此前也是一行 14px 灰字——同一个
 * 「新建对话」流里三种空态三种形，读者读到的分量不一样，可它们说的是同一级别的事。
 */
describe("从项目里挑：空的时候用同一种形", () => {
  function renderProjectPane(projects: NewConvProject[]) {
    return render(
      <ThemeProvider>
        <ProjectAgentPane
          projects={projects}
          agents={[]}
          onPick={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
  }

  it("一个项目都没有：走共享 EmptyState，且仍然说清去哪儿建", () => {
    renderProjectPane([]);

    const empty = screen.getByTestId("project-none-yet");
    // 共享 EmptyState 的图标圈：证明这里不是第三种手搓形态。
    expect(within(empty).getByTestId("empty-icon")).toBeTruthy();
    expect(empty.textContent).toContain("Projects");
  });

  it("项目选过图标时左树与右侧标题画的是同一枚：字形只有一种", () => {
    // 这一屏上同一个项目出现两次（左边树里一次、右半屏标题上一次）。解 key 那一步
    // 在共享包里，本站只要把 icon 一起递下去；漏递哪一处，那一处就退回项目名首字。
    renderProjectPane([
      { sync_id: "p-1", name: "server", color: "agent-3", icon: "code-xml" },
    ]);

    const glyphs = screen.getAllByRole("img", { name: "server" });
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) {
      expect(glyph.querySelector("svg")?.getAttribute("class")).toContain(
        "lucide-code-xml",
      );
    }
  });

  it("Agent 的图标在「从项目里挑」这一屏同样画得出来", () => {
    render(
      <ThemeProvider>
        <ProjectAgentPane
          projects={[{ sync_id: "proj-1", name: "server" }]}
          agents={agents}
          onPick={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );

    const avatar = screen.getByRole("img", { name: "Backend Agent" });
    expect(avatar.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-bot",
    );
  });

  it("项目里一个 Agent 都没有：同一种形，并说清 Agent 从哪来", () => {
    renderProjectPane([{ sync_id: "p-1", name: "server" }]);

    const empty = screen.getByTestId("project-agents-empty");
    expect(within(empty).getByTestId("empty-icon")).toBeTruthy();
    expect(empty.textContent).toContain("desktop");
  });
});

/**
 * 项目树同样是「还没取到」与「一个都没有」共用一个空清单（`/v1/workspace/projects`
 * 单独取，`projects` 的初值是空数组）。两件事在这一屏上说的话完全不同，而且第二
 * 条错得更久：选中项是 `useState` 的**初值**，项目晚一步到的话它永远停在 null
 * ——左边树里项目都列出来了，右半屏还挂着「还没有项目，去建一个」，除非用户自己
 * 点一下。这不是闪一下，是卡住。
 */
describe("从项目里挑：清单还在路上", () => {
  function renderProjectPane(
    projects: NewConvProject[],
    props: { projectsSettled?: boolean } = {},
  ) {
    return render(
      <ThemeProvider>
        <ProjectAgentPane
          projects={projects}
          agents={[]}
          onPick={vi.fn()}
          onBack={vi.fn()}
          {...props}
        />
      </ThemeProvider>,
    );
  }

  it("Given 项目还没问回来, When 打开这一屏, Then 摆骨架而不是「还没有项目」", () => {
    renderProjectPane([], { projectsSettled: false });

    expect(screen.queryByTestId("project-none-yet")).toBeNull();
    expect(screen.queryByText("No projects yet.")).toBeNull();
    expect(screen.getByTestId("project-tree-skeleton")).toBeTruthy();
  });

  it("Given 项目晚一步才到, When 它到了, Then 选中跟上第一个,不永久停在空态", () => {
    const { rerender } = renderProjectPane([], { projectsSettled: false });

    rerender(
      <ThemeProvider>
        <ProjectAgentPane
          projects={[{ sync_id: "p-1", name: "server" }]}
          agents={[]}
          onPick={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId("project-none-yet")).toBeNull();
    // 选中落在第一个项目上：右半屏谈的是它（这个项目里一个 Agent 都没有）。
    expect(screen.getByTestId("project-agents-empty")).toBeTruthy();
  });

  // 上面两条钉的是组件自己；这一条钉的是**接线**——「问过了没有」这一格由页面持有，
  // 不传下去的话组件那两条守卫一次都走不到（挑 Agent 那一处此前正是这么漏的）。
  it("Given 页面上项目那一路还没回来, When 走到这一屏, Then 摆的是骨架", async () => {
    stubReads();
    const base = mockedApi.getMockImplementation()!;
    mockedApi.mockImplementation(async (path, init) =>
      path.startsWith("/v1/workspace/projects")
        ? new Promise(() => {}) // 永不落定
        : base(path, init),
    );
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );
    fireEvent.click(await screen.findByTestId("new-conversation-from-project"));

    await screen.findByTestId("project-agent-pane");
    expect(screen.queryByTestId("project-none-yet")).toBeNull();
    expect(screen.getByTestId("project-tree-skeleton")).toBeTruthy();
  });
});

describe("开着新对话时还回得去", () => {
  // 桌面右栏被「新对话」接管之后，左栏那一列会话仍然点得动——点了就该回到那条
  // 会话。不清掉 compose 的话，点哪一行右栏都纹丝不动，人被困在挑 Agent 那一屏，
  // 除了真开一条对话没有别的出路。
  it("点左栏的一条会话，右栏从新对话回到那条会话", async () => {
    stubReads({}, [mirroredSession]);
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", { name: "New conversation" }),
    );
    expect(await screen.findByTestId("new-conversation-pane")).toBeTruthy();

    fireEvent.click(await screen.findByText("重构登录页"));

    await waitFor(() =>
      expect(screen.queryByTestId("new-conversation-pane")).toBeNull(),
    );
  });

  /*
    同一段空窗也落在左栏点行上：右栏要重新去问一次 `/v1/agent-sessions?conversation_id=`,
    而那一行的标题**就在刚点的那一行上**。等一次往返只为拿回已经有的东西,期间头部
    写着裸会话号。

    断言就落在点击**返回的那一刻**:`fireEvent.click` 会把渲染与 effect 刷掉,但
    那次取数的 promise 还没兑现 —— 这一帧正是用户看到闪动的那一帧。
  */
  it("点行进右栏那一刻,头部写的是这一行的标题,不是裸会话号", async () => {
    stubReads({}, [mirroredSession]);
    renderChat();

    fireEvent.click(await screen.findByText("重构登录页"));

    expect(
      within(screen.getByTestId("session-detail-identity")).getByRole("heading")
        .textContent,
    ).toBe("重构登录页");
  });

  it("从 draft 那一步点回一条会话同样回得去", async () => {
    stubReads({}, [mirroredSession]);
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();

    fireEvent.click(
      await screen.findByRole("button", { name: "New conversation" }),
    );
    fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
    expect(await screen.findByTestId("draft-session")).toBeTruthy();

    fireEvent.click(screen.getByText("重构登录页"));

    await waitFor(() =>
      expect(screen.queryByTestId("draft-session")).toBeNull(),
    );
  });
});

/**
 * 项目组头上那颗 ＋ 问的是「**在这个项目里**开对话」（规格 2026-08-20 决策 10），
 * 不是「挑一个 Agent」。它落进草稿时项目必须已经填好——否则那颗 ＋ 与顶栏那颗
 * 「新对话」做的是同一件事，组头这个入口等于在说谎，用户还得再挑一次项目。
 */
describe("从项目组头的 ＋ 开对话", () => {
  it("项目跟着一起带进草稿：计划按这个项目算，chip 上也是它", async () => {
    stubReads({}, [{ ...mirroredSession, project_sync_id: "proj-1" }]);
    mockFetchPlan.mockResolvedValue(availablePlan);
    renderChat();

    // Radix 的浮层开在 pointerdown 上，不是 click。
    const add = await screen.findByTestId("project-add-proj-1");
    fireEvent.pointerDown(add, { button: 0, ctrlKey: false });
    fireEvent.click(add);
    fireEvent.click(await screen.findByTestId("project-member-option-agent-1"));

    expect(await screen.findByTestId("draft-session")).toBeTruthy();
    await waitFor(() =>
      expect(mockFetchPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSyncId: "agent-1",
          projectSyncId: "proj-1",
        }),
      ),
    );
    expect(
      (await screen.findByTestId("draft-project-chip")).textContent,
    ).toContain("frontend");
  });
});

/**
 * 窄屏没有第二栏可以落这条新会话：挑 Agent 是底部弹层、草稿占满整屏，派发成功
 * 之后只能下钻到会话页——那也正是移动端读一条已有对话的形态（索引行就是链接）。
 */
describe("移动端派发成功后的落地", () => {
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

  afterAll(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("跳到会话页，而不是留在索引上", async () => {
    mockMobileViewport();
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: true,
      reasoningEffortPinned: true,
    });
    renderChat();
    await openDraft();

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("session page")).toBeTruthy();
  });
});

/**
 * 草稿页底栏的两颗控件（规格 2026-08-24-draft-session-composer-pills）。
 *
 * 此前这一屏一颗都没有：用户在发出第一句之前既看不见这一轮会用哪个档位、哪个
 * 模型，也改不了——要等派发成功进了详情页才第一次见到它们。而桌面端在同一处
 * （chat-panel 的「还没有对话」那一路）两颗都在。
 *
 * 档位只能问执行端本人：服务端不掌握任何后端的档位集合。所以这一屏在计划落定时
 * 就连上选中那台机器，问 `runtime.capabilities` 与 `runtime.session.list`。
 */
describe("草稿页的权限档位与模型控件", () => {
  const engineReads = {
    "/v1/engine/backends": {
      backends: [
        {
          sync_id: "b-a",
          provider_key: "pk-1",
          model_key: "mk-1",
          // 空 = 管理员没在 Agent 后端上预设档位。这一格非空的用例各自就地覆盖，
          // 免得「账号侧压过执行端」那条口径悄悄渗进本来无关的几条里。
          default_permission_mode: "",
        },
      ],
    },
    "/v1/engine/providers": {
      providers: [
        {
          provider_key: "pk-1",
          name: "Anthropic",
          type: "anthropic",
          default_model_key: "mk-1",
          enabled: true,
          models: [
            {
              model_key: "mk-1",
              model_id: "claude-sonnet-4-6",
              name: "Sonnet",
              enabled: true,
            },
            {
              model_key: "mk-2",
              model_id: "claude-opus-4-6",
              name: "Opus",
              enabled: true,
            },
          ],
        },
      ],
    },
  };

  /**
   * 让这一屏连上选中那台机器，并规定它怎么回答能力与清单两问。
   *
   * 清单里顺带放一条 99 号会话：派发成功后右栏就地换成它的真实详情，那一屏
   * 同样要靠这条连接把摘要问出来。
   */
  function stubMachine(
    caps: unknown,
    list: unknown = {
      sessions: [
        {
          conversationId: "99",
          title: "跑一下失败的测试",
          agentSyncId: "agent-1",
          backendType: "claudecode",
          lifecycleState: "idle",
          latestSeq: 0,
          peerFingerprint: "fp-a",
        },
      ],
    },
    relayState: "connected" | "reconnecting" = "connected",
  ) {
    const request = vi.fn(async (method: unknown) => {
      if (method === rpcMethods.runtimeCapabilities) {
        if (caps instanceof Error) throw caps;
        return caps;
      }
      if (method === rpcMethods.sessionList) return list;
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      return {};
    });
    mockUseRelay.mockReturnValue({
      client: {
        request,
        attach: vi.fn(async () => ({})),
        catchUp: vi.fn(async () => {}),
        setCursor: vi.fn(),
        getCursor: vi.fn(() => 0),
        close: vi.fn(),
      } as never,
      relayState,
      relayTicket,
      relayTicketError: null,
      reconnect: vi.fn(),
    });
    return request;
  }

  // 同一份应答里另一格：`capabilities` 是一串 {name, enabled}。
  const capsWithEffort = {
    capabilities: [{ name: "reasoning_effort", enabled: true }],
    permissionMode: { allowedModes: [] },
  };

  // Protobuf 的 RuntimeCapabilitiesResponse：档位在自己那一格 permission_mode 上。
  const fourModes = {
    capabilities: [],
    permissionMode: {
      allowedModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
      defaultMode: "acceptEdits",
      order: ["default", "acceptEdits", "plan", "bypassPermissions"],
      switchableDuringTurn: true,
    },
  };

  beforeEach(() => {
    stubReads(engineReads);
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: true,
      reasoningEffortPinned: true,
    });
  });

  it("Given 计划落定, When 打开草稿, Then 两颗控件都在，档位起手值是执行端报的默认档", async () => {
    stubMachine(fourModes);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    const pill = await screen.findByRole("button", { name: /Permission mode/ });
    // 账号侧没有预设（engineReads 里那一格是空串），此时起手值取执行端自己报的
    // DefaultMode，不是本站写死的第一档。
    expect(pill.textContent).toContain("Accept Edits");
    expect(screen.getByTestId("composer-model-target")).toBeTruthy();
  });

  /**
   * 账号侧那一档必须压过执行端报的 DefaultMode。
   *
   * claudecode 的 DefaultMode 是 runtime 能力矩阵里写死的常量 "acceptEdits"
   * （agentre `runtimes/claudecode/runtime.go`），不是「这台机器的偏好」；把它排在
   * 管理员预设前面，等于让 Agent 上配的 bypass 永远够不着。而且这一档会**显式**
   * 随第一句过线，执行端 `CreatePermissionMode` 收到非空值就直接采信，连它自己那
   * 条 backend 兜底也一并跳过——所以这不只是显示错，会话是真的按错的档起手的。
   *
   * 顺序与桌面端 `normalizePermissionMode(raw, allowed, defaultMode, backendDefault)`
   * 同一份实现，也与本站会话详情页同一条口径。
   */
  it("Given Agent 后端预设了 bypass, When 打开草稿, Then 起手值是账号侧那一档并随第一句过线", async () => {
    stubReads({
      ...engineReads,
      "/v1/engine/backends": {
        backends: [
          {
            sync_id: "b-a",
            provider_key: "pk-1",
            model_key: "mk-1",
            default_permission_mode: "bypassPermissions",
          },
        ],
      },
    });
    stubMachine(fourModes);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    const pill = await screen.findByRole("button", { name: /Permission mode/ });
    expect(pill.textContent).toContain("Bypass");

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(mockDispatch.mock.calls[0][0].permissionMode).toBe(
      "bypassPermissions",
    );
  });

  /**
   * 归一化的另一半：账号侧那一档如果不在这台机器报的集合里（换了执行目标、或后端
   * 换了种类），它就不算数，退回执行端的默认档，而不是把一个这台机器不认的字面量
   * 摆上去、再随第一句发出去让执行端报非法。
   */
  it("Given 账号侧那一档不在这台机器的集合里, When 打开草稿, Then 退回执行端的默认档", async () => {
    stubReads({
      ...engineReads,
      "/v1/engine/backends": {
        backends: [
          {
            sync_id: "b-a",
            provider_key: "pk-1",
            model_key: "mk-1",
            default_permission_mode: "bypassPermissions",
          },
        ],
      },
    });
    stubMachine({
      capabilities: [],
      permissionMode: {
        allowedModes: ["default", "plan"],
        defaultMode: "default",
        order: ["default", "plan"],
        switchableDuringTurn: true,
      },
    });
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    const pill = await screen.findByRole("button", { name: /Permission mode/ });
    expect(pill.textContent).toContain("Default");
    expect(pill.textContent).not.toContain("Bypass");
  });

  it("Given 机器答不出档位, When 打开草稿, Then 直接说明问不到，不显示 unknown 档位", async () => {
    stubMachine(new Error("machine says no"));
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    expect(
      screen.queryByRole("button", { name: /Permission mode/ }),
    ).toBeNull();
    expect(
      await screen.findByText(
        "This machine cannot list permission modes right now",
      ),
    ).toBeTruthy();
  });

  // 与上一条是两件不同的事，但只有上一条值得说：这一条是稳定答案（这个后端没有
  // 权限门），底栏空着就是完整的答案，与桌面端同一处置；上一条是本该有档却问不
  // 出来，属于异常，仍要说。
  it("Given 后端本来就没有权限门, When 打开草稿, Then 控件整颗不摆，且档位不随第一句过线", async () => {
    const request = stubMachine({
      capabilities: [],
      permissionMode: { allowedModes: [] },
    });
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    // 应答已消费：底栏要说的话此刻早该在了。
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        rpcMethods.runtimeCapabilities,
        expect.anything(),
      ),
    );
    expect(
      screen.queryByRole("button", { name: /Permission mode/ }),
    ).toBeNull();
    expect(
      screen.queryByText("This backend has no permission modes"),
    ).toBeNull();

    await typeInDraft("hi");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    // piagent 那一路把 RunParams.PermissionMode 当远端 generation token 比对，
    // 塞一个真档位进去会让那一轮被判成 stale —— 闸门是「执行端报了非空集合」，
    // 不是在本站按后端类型写死一条黑名单。
    expect(mockDispatch.mock.calls[0][0].permissionMode).toBeUndefined();
  });

  it("Given 旧连接正在重连, When 发第一句, Then 不把未就绪 client 交给派发", async () => {
    stubMachine(fourModes, undefined, "reconnecting");
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    await typeInDraft("hi");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(mockDispatch.mock.calls[0][0].client).toBeUndefined();
  });

  it("Given Agent 后端绑了模型, When 打开草稿, Then 模型 pill 是跟随绑定态并写出解析到的模型", async () => {
    stubMachine(fourModes);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    const pill = await screen.findByRole("button", {
      name: /Provider and model/,
    });
    expect(pill.textContent).toContain("Follow agent binding");
    // 脸上写的是标识符而不是人读名 —— 与桌面端、与包里触发器的注释同一条口径。
    expect(pill.textContent).toContain("claude-sonnet-4-6");
  });

  it("Given 用户改了档位又挑了模型, When 发出第一句, Then 两样都随它过线", async () => {
    stubMachine(fourModes);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    fireEvent.click(
      await screen.findByRole("button", { name: /Permission mode/ }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /Provider and model/ }));
    fireEvent.click(screen.getByRole("option", { name: /Opus/ }));

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    const input = mockDispatch.mock.calls[0][0];
    expect(input.permissionMode).toBe("plan");
    expect(input.modelTarget).toEqual({
      providerKey: "pk-1",
      modelKey: "mk-2",
    });
  });

  /**
   * 草稿页的第三颗控件：会话级思考力度（规格 2026-09-01）。草稿态还没有会话行，
   * 所选档位是纯瞬态的，随第一句一并过线（并由派发在 ack 之后补钉）。
   *
   * 支不支持同样问执行端本人：能力位为假（openclaw）时整颗不渲染。
   */
  it("Given 后端声明 reasoning_effort, When 选一档并发出第一句, Then 它随第一句过线", async () => {
    stubMachine(capsWithEffort);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    fireEvent.click(
      await screen.findByRole("button", { name: /Reasoning effort/ }),
    );
    fireEvent.click(screen.getByRole("option", { name: "xhigh" }));

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(mockDispatch.mock.calls[0][0].reasoningEffort).toBe("xhigh");
  });

  it("Given 后端没有这个能力, When 打开草稿, Then 力度控件整颗不摆", async () => {
    const request = stubMachine(fourModes);
    renderChat();
    await openDraft();
    await awaitDraftComposer();

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        rpcMethods.runtimeCapabilities,
        expect.anything(),
      ),
    );
    expect(screen.queryByTestId("composer-reasoning-effort")).toBeNull();
  });

  // 钉不住不影响这条对话开起来（第一轮就是按所选模型跑的），但后续轮次会回到跟随
  // 绑定。不说的话，详情页会对着一条其实没钉住的对话显示「跟随 Agent 绑定」，
  // 而用户明明选过 —— 一句他无法证伪的假话。
  it("Given 模型没能钉住, When 进了这条新对话, Then 详情页如实说出来", async () => {
    // 详情那一屏要认得出承载它的那台机器（/v1/devices 非空）才铺得开输入框。
    stubReads(engineReads, [mirroredSession]);
    stubMachine(fourModes);
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: false,
      reasoningEffortPinned: true,
    });
    // 左栏已经有一行了，空态那颗主动作不在：走 compose 那个入口进草稿。
    renderChat("/chat?compose=1");
    fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
    await screen.findByTestId("draft-session");
    await awaitDraftComposer();

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    expect(await screen.findByTestId("session-detail-view")).toBeTruthy();
    await waitFor(
      () =>
        expect(screen.getByTestId("composer-model-note").textContent).toBe(
          "This conversation could not pin your model choice; the first turn used it, later turns follow the agent binding",
        ),
      { timeout: 3000 },
    );
  });

  /*
    力度没能钉住，与模型没能钉住是同一件事：第一轮按所选档位跑了，后续轮次会回到
    跟随后端配置。不说的话，详情页会对着一条其实没钉住的对话显示「默认」，而用户
    明明选过 —— 一句他无法证伪的假话，正是这一轮规格在治的东西。
  */
  it("Given 力度没能钉住, When 进了这条新对话, Then 详情页如实说出来", async () => {
    stubReads(engineReads, [mirroredSession]);
    stubMachine(capsWithEffort);
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: true,
      reasoningEffortPinned: false,
    });
    renderChat("/chat?compose=1");
    fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
    await screen.findByTestId("draft-session");
    await awaitDraftComposer();

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    expect(await screen.findByTestId("session-detail-view")).toBeTruthy();
    await waitFor(
      () =>
        expect(screen.getByTestId("composer-effort-note").textContent).toBe(
          "This conversation could not pin your reasoning effort; the first turn used it, later turns follow the backend config",
        ),
      { timeout: 3000 },
    );
  });

  /*
    交接那一拍的标题。

    右栏换成真详情时，这一屏什么都还没问到：`session.list` 要等中继票 + WS +
    attach，账号镜像那一行要等一次 HTTP。两条都没落地时头部退回 `#<身份前 8 位>` ——
    一串十六进制，既不是这条对话的名字，也不是用户认得的任何东西。实测在联调
    机上摆了约 800 毫秒，正好是「消息发出去之后画面在闪」的那一段。

    而这个名字**派发那一刻就在手里**：标题就是 `deriveTitle(第一句话)`，
    `dispatchNewConversation` 自己算出来送给 daemon 的那一份。交接时把它一起递
    过来，头部第一帧就说得出这条对话叫什么，不必等任何一次往返。
  */
  it("Given 摘要与镜像都还没落地, When 右栏换成详情, Then 头部写的是刚发出去那一句,不是裸身份", async () => {
    stubReads(engineReads, [mirroredSession]);
    // 清单里**没有** 99 号：摘要这条来路就停在这儿。镜像那一行是 42 号，也配不上
    // ——两条来路都空着，正是交接那一拍的样子，只是把它定住了。
    stubMachine(fourModes, { sessions: [] });
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: true,
      reasoningEffortPinned: true,
    });
    renderChat("/chat?compose=1");
    fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
    await screen.findByTestId("draft-session");
    await awaitDraftComposer();

    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    expect(await screen.findByTestId("session-detail-view")).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByTestId("session-detail-identity")).getByRole(
          "heading",
        ).textContent,
      ).toBe("跑一下失败的测试"),
    );
    expect(screen.queryByText("#99")).toBeNull();
  });

  // 没有选中的机器就没有「哪个后端」这一问：此刻摆一颗禁用的 pill 是在暗示
  // 「有台机器只是暂时答不上来」。
  it("Given 一档都不可用, When 打开草稿, Then 两颗控件整块不摆", async () => {
    stubMachine(fourModes);
    mockFetchPlan.mockResolvedValue(allUnavailablePlan);
    renderChat();
    await openDraft();
    await screen.findByTestId("draft-all-unavailable");

    expect(screen.queryByTestId("composer-model-target")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Permission mode/ }),
    ).toBeNull();
  });
});

/**
 * 交接那一拍：右栏从草稿换成真详情，而转录的两条来路都还在路上（账号镜像是一次
 * HTTP，中继要票 + WS + attach + 补齐）。
 *
 * 草稿那一屏在派发在飞时已经把用户刚说的那句话与三点画出来了；交接之后详情从空
 * 事件表起手，于是那一段被一片骨架顶掉，等两条来路之一落地才回来 —— 用户发出第一句
 * 之后眼看着自己的话消失、界面重搭一遍，而那正是他最想知道「开起来了没有」的时候。
 */
describe("交接那一拍：刚发出去的第一句不掉下去", () => {
  beforeEach(() => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: true,
      reasoningEffortPinned: true,
    });
  });

  it("Given 转录两条来路都还没落地, When 右栏换成详情, Then 那句话与三点接着留在转录里", async () => {
    renderChat("/chat?compose=1");
    fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
    await screen.findByTestId("draft-session");
    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    const view = await screen.findByTestId("session-detail-view");
    expect(within(view).queryByTestId("draft-pending")).toBeNull();

    // 标题那一格也写着同一句，所以只认转录那一带。
    const scroll = await screen.findByTestId("session-detail-scroll");
    await waitFor(() =>
      expect(within(scroll).queryByText("跑一下失败的测试")).toBeTruthy(),
    );
    expect(screen.getByRole("status", { name: "Generating" })).toBeTruthy();
    // 手上有东西可画就不摆骨架：骨架说的是「什么都还没有」。
    expect(within(scroll).queryByTestId("transcript-skeleton")).toBeNull();
  });

  /**
   * 派发成功之后那台机器随即掉线（派发那一刻它还在）。
   *
   * 接力那一条只在「还有理由认为转录会来」时算数：机器够不着时它得让位给那句
   * 「读不到」，否则三点会对着一台没人在的机器一直转 —— 那是在替远端撒谎，
   * 与转录那边「通道断了就先说通道」是同一条规矩。
   */
  it("Given 派发完那台机器就掉线, When 右栏换成详情, Then 让位给「读不到」而不是一直转三点", async () => {
    stubReads();
    // 设备名单那一路 stubReads 自己答（恒为在线），要的正好相反：包一层，只把
    // 这一条换掉 —— 派发那一刻它还在，落地那一屏问到的已经是离线。
    const reads = mockedApi.getMockImplementation();
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) =>
      path === "/v1/devices"
        ? {
            devices: [
              {
                id: 20,
                name: "Study Mini",
                kind: "agentred",
                fingerprint: "fp-a",
                online: false,
                status: 1,
              },
            ],
          }
        : reads!(path, init),
    );
    renderChat("/chat?compose=1");
    fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
    await screen.findByTestId("draft-session");
    await typeInDraft("跑一下失败的测试");
    const send = screen.getByTestId("session-detail-send");
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);

    expect(
      await screen.findByTestId("session-history-unavailable"),
    ).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Generating" })).toBeNull();
  });
});

/**
 * 顶带：**四态同一副外壳**（桌面端 chat-panel-header 的规格 2026-08-23 决策 2/3）。
 *
 * 「还没发第一句」与「这条对话已经开着」在桌面端是同一条 68px 带，只是标题与 meta
 * 各段换了内容。控制台此前是两副头：草稿那副 `py-3` + 24px 头像，右栏顶上还另叠
 * 着一条 68px 的 chat-chrome；第一句一发出去，chrome 整条消失、头换成详情那副
 * 68px 的 —— 顶部 116px 塌到 68px，头像 24→32，转录整体上跳。
 *
 * 现在两处共用共享包的 `SessionHeaderBand`，这一组用例盯的就是「同一副」。
 */
describe("草稿与详情共用同一条顶带", () => {
  /**
   * 一条带里的头像那一格 —— 带的第一个孩子（这两屏都不带 leading）。
   *
   * 取位置而不是取 `role="img"`：身份认不出来时那一格摆的是一枚占位方块（详情
   * 落地的头一瞬正是这样，账号 Agent 名单还没回来），而这条用例要说的恰恰是
   * 「那一格无论如何都占住」。
   */
  function avatarIn(band: HTMLElement): HTMLElement {
    const el = band.firstElementChild as HTMLElement | null;
    if (!el) throw new Error("头像那一格空着");
    return el;
  }

  it("草稿的顶带与发出去之后那条同形：68px、同一档头像，桌面右栏只此一条带", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    mockDispatch.mockResolvedValue({
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "跑一下失败的测试",
      userText: "跑一下失败的测试",
      modelPinned: true,
      reasoningEffortPinned: true,
    });
    renderChat();
    await openDraft();

    const draftBand = screen.getByTestId("draft-header");
    expect(draftBand.className).toMatch(/h-\[68px\]/);
    expect(draftBand.className).toContain("@container/header");
    expect(avatarIn(draftBand).className).toContain("size-8");
    // 草稿那条带**就是**右栏的顶带：页面级那簇控件落进它的右端，chat-chrome
    // 因此不再另画一条 —— 那正是发出第一句时会凭空消失的 68px。
    expect(screen.queryByTestId("chat-chrome")).toBeNull();
    expect(
      within(draftBand).getByRole("button", { name: /Language/i }),
    ).toBeTruthy();

    await typeInDraft("跑一下失败的测试");
    await waitFor(() =>
      expect(
        screen.getByTestId("session-detail-send").hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("session-detail-send"));

    await screen.findByTestId("session-detail-view");
    const liveBand = screen.getByTestId("session-detail-identity");
    expect(liveBand.className).toMatch(/h-\[68px\]/);
    expect(liveBand.className).toContain("@container/header");
    expect(avatarIn(liveBand).className).toContain("size-8");
  });

  it("标题槽先写「新对话 · Agent」；第一句一交出去就换成那句话本身", async () => {
    stubReads();
    mockFetchPlan.mockResolvedValue(availablePlan);
    mockEnsureRelayTicket.mockResolvedValue(relayTicket);
    // 派发一直在飞：量的是「已经交出去、还没落地」的那一段。
    mockDispatch.mockImplementation(() => new Promise(() => {}));
    renderChat();
    await openDraft();

    const band = () => screen.getByTestId("draft-header");
    expect(
      within(band()).getByRole("heading", { name: "New chat · Backend Agent" }),
    ).toBeTruthy();
    // meta 行的第一段与详情那条同形同序：状态点 + Agent 名。
    expect(screen.getByTestId("draft-header-meta").textContent).toContain(
      "Backend Agent",
    );

    await typeInDraft("跑一下失败的测试");
    await waitFor(() =>
      expect(
        screen.getByTestId("session-detail-send").hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("session-detail-send"));

    // 标题这一刻就是详情落地后会显示的那一个（同一个 deriveTitle 算的同一件事），
    // 于是右栏换成真详情时标题一个字都不动。
    await waitFor(() =>
      expect(
        within(band()).getByRole("heading", { name: "跑一下失败的测试" }),
      ).toBeTruthy(),
    );
  });
});
