/**
 * 「对话」页（R12 的桌面入口 + R13 + R14 的关注名单测试接缝，web vitest）：
 *   - 空态：Agent 骨架照常列出、每个 Agent 一行「还没有对话」；主动作「开始第一个
 *     对话」（R15，本轮只摆按钮，task 8 接流程）；次要出口去设备页；空态文案里
 *     不出现「关注」机制词（没有 Follow / Unfollow 控件）。
 *   - 关注来的会话在这里出现、不需要下钻：只消费账号级 /v1/follows（R14，任一端
 *     关注后另一端读到同一份），连到目标机器解析出标题 / 状态 / 等待输入（R13），
 *     按 Agent 分组；机器落在每一行的小字上，不作分组维度。
 *   - R12：行尾关注开关（这里是取消关注），只影响这一条、不动别的行/别的端。
 *   - R13：机器离线时该条仍在名单里并标明离线、不消失；目标已不存在时标失效并可
 *     一键移除（设备被撤销 / 会话在机器上已不存在两种情况）。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine, type UseRelayMachineResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { formatRelativeTime } from "@/lib/sessionView";
import { ThemeProvider } from "@/lib/theme";
import Chat from "@/pages/Chat";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);

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

function connectedRelay(): UseRelayMachineResult {
  return {
    client: fakeClient as never,
    relayState: "connected",
    webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
    webDeviceError: null,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  fakeClient.request.mockReset();
  fakeClient.request.mockImplementation(async (method: string) => {
    if (method === "runtime.session.list") return { sessions: [summary] };
    throw new Error("unexpected method: " + method);
  });
});

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <ThemeProvider>
        <Routes>
          <Route path="/chat" element={<Chat />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("对话页:R12 桌面入口 + R13 + R14 关注名单", () => {
  it("空态:桌面 320px 左列 + 居中详情空态,TopBar 注入 Cnt/FindBtn,主动作开新对话,文案不含「关注」", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows") return { items: [] };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    renderChat();

    // 页标题移进外壳 TopBar（设计稿屏 49b），不再有正文 h1。
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Chat")).toBeTruthy();
    // 桌面形态:320px 左会话列表列 + 右侧详情区。
    const listCol = screen.getByTestId("chat-list-col");
    expect(listCol.className).toContain("w-[320px]");
    expect(screen.getByTestId("chat-detail")).toBeTruthy();
    // Agent 骨架照常列出、每个 Agent 一行「还没有对话」，空态详情自己也顶着同一句。
    expect(
      await screen.findByRole("heading", { name: /后端 Agent/ }),
    ).toBeTruthy();
    expect(screen.getAllByText("No conversations yet.").length).toBe(2);
    expect(
      screen.getByRole("heading", { name: "No conversations yet." }),
    ).toBeTruthy();
    // 空态正文沿用设计稿屏 32 原文（文案原样不动）。
    expect(
      screen.getByText(
        "Pick an agent to get started. It works in the project directory you choose, and asks you before every step that needs permission.",
      ),
    ).toBeTruthy();
    // 主动作「开始第一个对话」打开新对话弹层（屏 23/24/25）。
    const startBtn = screen.getByRole("button", {
      name: "Start your first conversation",
    });
    // 次要出口去设备页 + 备选链接去设备页。
    const devLink = screen.getByRole("link", { name: /devices page/ });
    expect(devLink.getAttribute("href")).toBe("/devices");
    // TopBar:会话总数 Cnt + FindBtn（去设备页关注更多对话）。
    expect(screen.getByTestId("chat-count").textContent).toBe("0");
    const findBtn = screen.getByRole("link", {
      name: "Follow conversations from your device",
    });
    expect(findBtn.getAttribute("href")).toBe("/devices");
    // 没有在线桌面设备时 Fresh 不出现（不谎报「已连接」）。
    expect(screen.queryByText("Desktop connected")).toBeNull();
    // 空态文案里不出现「关注」机制词。
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unfollow" })).toBeNull();
    // 页面只消费账号级名单。
    expect(mockedApi).toHaveBeenCalledWith("/v1/follows");

    fireEvent.click(startBtn);
    expect(
      await screen.findByRole("heading", { name: "Pick an agent" }),
    ).toBeTruthy();
  });

  it("R14:关注来的会话在这里出现(不需要下钻)——从 /v1/follows 读名单、连到目标机器解析,按 Agent 分组,行尾有关注开关", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents")
        return { agents: [...agents, { sync_id: "ag-2", name: "前端 Agent" }] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    // 标题 + 状态。
    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    // 机器 · 时间 第二行(机器不作分组维度,落在行上)。
    expect(screen.getByText(/书房小主机 · /)).toBeTruthy();
    // Agent 分组名;没会话的 Agent 仍然列出、给「还没有对话」。
    expect(screen.getByRole("heading", { name: /后端 Agent/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /前端 Agent/ })).toBeTruthy();
    expect(screen.getByText("No conversations yet.")).toBeTruthy();
    // 行尾关注开关(这里是取消关注)。
    expect(screen.getByRole("button", { name: "Unfollow" })).toBeTruthy();
    // 行链到详情页(复用 T6 的读转录/发消息,不必先去设备页)。
    const row = screen.getByText("重构登录页").closest("a");
    expect(row?.getAttribute("href")).toBe("/devices/1/sessions/42");
    // 数据从中继解析,而非在别的页下钻。
    expect(fakeClient.request).toHaveBeenCalledWith("runtime.session.list");
    // 有会话时:TopBar Cnt = 会话数;详情区不再显示「还没有对话」居中空态。
    expect(screen.getByTestId("chat-count").textContent).toBe("1");
    expect(
      screen.queryByRole("heading", { name: "No conversations yet." }),
    ).toBeNull();
    // 有在线 agentred 设备时,TopBar 出现 Fresh「桌面端已连接」。
    expect(screen.getByText("Desktop connected")).toBeTruthy();
  });

  it("R13:机器离线时该条仍在名单里并标明离线,不消失", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-2",
              session_id: "7",
              followed_at: 1753000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [offlineMachine] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    renderChat();

    // 该条仍在名单里,标明离线;不因为机器离线就消失。
    expect(await screen.findByText(/公司 Mac mini · offline/)).toBeTruthy();
    // 离线机器不尝试连接。
    expect(mockUseRelay).not.toHaveBeenCalled();
    // Agent 骨架仍在。
    expect(screen.getByRole("heading", { name: /后端 Agent/ })).toBeTruthy();
  });

  it("R13:目标设备已不存在时标失效,可一键移除", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: true,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/workspace/agents") return { agents };
      if (path === "/v1/follows/unfollow") return {};
      throw new Error("unexpected: " + path);
    });
    renderChat();

    expect(await screen.findByText("Unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
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
    // 移除后条目消失。
    await waitFor(() => expect(screen.queryByText("Unavailable")).toBeNull());
  });

  it("R13:目标会话在机器上已不存在时标失效,可移除", async () => {
    // 关注指向 99,但机器上只有 42。
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "99",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    renderChat();

    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("R12:行尾取消关注只影响这一条,别的行/别的端不受影响", async () => {
    const summary43 = { ...summary, sessionId: 43, title: "修 bug" };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
            {
              device_fingerprint: "fp-1",
              session_id: "43",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      if (path === "/v1/follows/unfollow") return {};
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async (method: string) => {
      if (method === "runtime.session.list")
        return { sessions: [summary, summary43] };
      throw new Error("unexpected method: " + method);
    });
    renderChat();

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(screen.getByText("修 bug")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Unfollow" }).length).toBe(2);

    // 取消关注第 42 条:只调 unfollow 端点、参数正确、只去掉这一条。
    fireEvent.click(screen.getAllByRole("button", { name: "Unfollow" })[0]);
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
    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
    expect(screen.getByText("修 bug")).toBeTruthy();
  });
});

// R13：「对话」页每条会话行的第二行是「机器 · 时间」，而这个时间与 R5 是同一套
// 信息——**最后活动时间**，不是关注时间。关注时间说不出这条对话什么时候动过，
// 而 web 自己发起的那条更会永远停在创建那一刻。
describe("对话页:行上的时间是最后活动时间", () => {
  it("第二行渲染会话的 updatedAt,而不是 followed_at", async () => {
    const lastActive = 1754800000000;
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 1,
              name: "书房小主机",
              kind: "agentred",
              fingerprint: "fp-1",
              last_seen_at: lastActive,
              status: 1,
              online: true,
            },
          ],
        };
      if (path === "/v1/workspace/agents")
        return { agents: [{ sync_id: "ag-1", name: "后端 Agent" }] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    fakeClient.request.mockImplementation(async (method: string) => {
      if (method === "runtime.session.list")
        return {
          sessions: [{ ...summary, updatedAt: lastActive }],
          supportsSessionMetadata: true,
        };
      throw new Error("unexpected method: " + method);
    });

    renderChat();

    await screen.findByText("重构登录页");
    // 第二行的时间是会话的最后活动时间（updatedAt），不是 followed_at=1000。
    const expected = formatRelativeTime(lastActive, "en");
    expect(screen.getByText(`书房小主机 · ${expected}`)).toBeTruthy();
    expect(
      screen.queryByText(`书房小主机 · ${formatRelativeTime(1000, "en")}`),
    ).toBeNull();
  });
});

// R13：这一页的每一行都靠 runtime.session.list 解析（标题 / 状态 / 等待输入 /
// 最后活动时间）。机器掉线再回来时必须**重新**解析一次：断连期间那条对话可能跑完
// 了、可能停下来等审批，而页面上还挂着断线前那一刻的状态——用户对着一个早就过时
// 的「运行中」等下去。守卫必须按「这条连接解析过没有」判定，不能拿状态字符串跟
// 它自己比（那个比较恒成立，重连后一次也不会再解析）。
describe("对话页:重连后重新解析会话状态", () => {
  it("connected → reconnecting → connected 会再发一次 runtime.session.list", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1754000000000,
              invalid: false,
            },
          ],
        };
      if (path === "/v1/devices") return { devices: [agentred] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue(connectedRelay());
    const view = renderChat();

    await screen.findByText("重构登录页");
    await waitFor(() => expect(fakeClient.request).toHaveBeenCalledTimes(1));

    // 掉线。
    mockUseRelay.mockReturnValue({
      ...connectedRelay(),
      relayState: "reconnecting",
    });
    view.rerender(
      <MemoryRouter initialEntries={["/chat"]}>
        <ThemeProvider>
          <Routes>
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );

    // 连回来：必须重新解析一次，页面上的状态才不是断线前那一刻的。
    mockUseRelay.mockReturnValue(connectedRelay());
    view.rerender(
      <MemoryRouter initialEntries={["/chat"]}>
        <ThemeProvider>
          <Routes>
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(fakeClient.request).toHaveBeenCalledTimes(2));
  });
});
