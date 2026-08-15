/**
 * 「对话」页（R12 的桌面入口 + R13 + R14 的关注名单测试接缝，web vitest）+ T6 的
 * 会话列表 UX（p5Orc「优化」）：
 *   - 空态：Agent 骨架照常列出、每个 Agent 一行「还没有对话」；主动作「开始第一个
 *     对话」（R15，本轮只摆按钮，task 8 接流程）；次要出口去设备页；空态文案里
 *     不出现「关注」机制词（没有 Follow / Unfollow 控件）。
 *   - 关注来的会话在这里出现、不需要下钻：只消费账号级 /v1/follows（R14，任一端
 *     关注后另一端读到同一份），连到目标机器解析出标题 / 状态 / 等待输入（R13），
 *     按 Agent 分组；机器落在每一行的小字上，不作分组维度。
 *   - R12：行尾关注开关（这里是取消关注），只影响这一条、不动别的行/别的端。
 *   - R13：机器离线时该条仍在名单里并标明离线、不消失；目标已不存在时标失效并可
 *     一键移除（设备被撤销 / 会话在机器上已不存在两种情况）。
 *   - T6 桌面形态：顶部「最近 · 跨 Agent」扁平区（跨全部 Agent 取最近 5 条）+
 *     筛选 chips（全部/运行中/未读 N）+ ↑↓ 键盘导航 + 选中高亮 + 行上右键菜单
 *     （只放真实后端动作：新标签打开 / 取消关注 / 移除失效；改名/删除无后端支持
 *     则省略，不伪造）。
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
// 桌面右栏嵌的是 task 5 的真实 SessionDetailView（其真实 relay/审批行为由
// session-detail.test.tsx 守）；本文件把真实详情 mock 成探针，只断言 Chat 以正确的
// deviceId/sessionId/form 消费它。
vi.mock("@/components/session/SessionDetailView", () => ({
  __esModule: true,
  default: (props: {
    deviceId: number;
    sessionId: number;
    form?: "page" | "embedded";
  }) => (
    <div
      data-testid="embedded-session-detail"
      data-device-id={props.deviceId}
      data-session-id={props.sessionId}
      data-form={props.form ?? "page"}
    >
      embedded-detail
    </div>
  ),
}));

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
    relayTicket: {
      clientId: "fp-web",
      clientName: "Browser",
      accessToken: "t",
    },
    relayTicketError: null,
  };
}

/**
 * 用「关注列表 + 会话解析」的常见骨架替测试垫好 mock：follows 来自调用方,
 * session.list 返回的会话按 follows 里的 sid 过滤（与 FollowedMachineResolver
 * 的行为一致）。
 */
function stubChat(
  follows: Array<{
    fp: string;
    sid: number;
    followedAt: number;
    invalid?: boolean;
  }>,
  sessions: unknown[],
  device: typeof agentred = agentred,
  agentList: typeof agents = agents,
) {
  mockedApi.mockImplementation(async (path) => {
    if (path === "/v1/follows")
      return {
        items: follows.map((f) => ({
          device_fingerprint: f.fp,
          session_id: String(f.sid),
          followed_at: f.followedAt,
          invalid: !!f.invalid,
        })),
      };
    if (path === "/v1/devices") return { devices: [device] };
    if (path === "/v1/workspace/agents") return { agents: agentList };
    if (path === "/v1/follows/unfollow") return {};
    throw new Error("unexpected: " + path);
  });
  mockUseRelay.mockReturnValue(connectedRelay());
  const wanted = new Set(follows.map((f) => f.sid));
  fakeClient.request.mockImplementation(async (method: string) => {
    if (method === "runtime.session.list")
      return {
        sessions: (sessions as Array<{ sessionId: number }>).filter((s) =>
          wanted.has(s.sessionId),
        ),
      };
    throw new Error("unexpected method: " + method);
  });
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
    // 详情区空态与 Agent 骨架各一句「还没有对话」(共享 EmptyState 的空态层级)。
    expect(screen.getAllByText("No conversations yet.").length).toBe(2);
    expect(
      within(screen.getByTestId("chat-detail")).getByText(
        "No conversations yet.",
      ),
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

  it("Fresh 只在有在线 agentred 时渲染:仅浏览器(web)在线不显示「桌面端已连接」(不编状态)", async () => {
    // /v1/devices 里只有本浏览器(web)在线、没有任何 agentred → 不算「桌面已连接」。
    const webOnly = {
      id: 9,
      name: "This Browser",
      kind: "web",
      fingerprint: "fp-web",
      last_seen_at: 1754000000000,
      status: 1,
      online: true,
    };
    stubChat([], [], webOnly);
    renderChat();
    // 等页面稳定(空态 + Cnt=0 渲染出来)。
    await screen.findByTestId("chat-count");
    expect(screen.getAllByText("No conversations yet.").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Desktop connected")).toBeNull();
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

    // 标题（「最近」区与 Agent 分组各出现一次）。
    expect((await screen.findAllByText("重构登录页")).length).toBeGreaterThan(
      0,
    );
    // 状态点:运行状态有 aria(不只靠颜色)。
    expect(screen.getAllByRole("img", { name: "Idle" }).length).toBeGreaterThan(
      0,
    );
    // Row2 设备 · 后端(设备名来自关注名单解析出的设备)。
    expect(
      screen.getAllByText(/书房小主机 · claudecode/).length,
    ).toBeGreaterThan(0);
    // Agent 分组名;没会话的 Agent 仍然列出、给「还没有对话」。
    expect(screen.getByRole("heading", { name: /后端 Agent/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /前端 Agent/ })).toBeTruthy();
    // 「还没有对话」= 无会话的 Agent 骨架 + 未选中时右栏的 kpP7A 空态。
    expect(screen.getAllByText("No conversations yet.").length).toBe(2);
    // 行尾关注开关(这里是取消关注)。
    expect(screen.getByRole("button", { name: "Unfollow" })).toBeTruthy();
    // 未选中时右栏按 kpP7A 空态层级呈现(「还没有对话」在 Agent 骨架与详情区各一句)。
    expect(
      within(screen.getByTestId("chat-detail")).getByText(
        "No conversations yet.",
      ),
    ).toBeTruthy();
    // 点行:桌面右栏嵌入 task 5 的真实详情视图(deviceId/sessionId, form=embedded),
    // 不必先去设备页。
    fireEvent.click(screen.getAllByText("重构登录页")[0]);
    const embedded = await screen.findByTestId("embedded-session-detail");
    expect(embedded.getAttribute("data-device-id")).toBe("1");
    expect(embedded.getAttribute("data-session-id")).toBe("42");
    expect(embedded.getAttribute("data-form")).toBe("embedded");
    // 数据从中继解析,而非在别的页下钻。
    expect(fakeClient.request).toHaveBeenCalledWith("runtime.session.list");
    // 有会话时:TopBar Cnt = 会话数。
    expect(screen.getByTestId("chat-count").textContent).toBe("1");
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

    expect((await screen.findAllByText("重构登录页")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("修 bug").length).toBeGreaterThan(0);
    // 两行各一个取消关注开关(「最近」区不重复放开关)。
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
    expect(screen.getAllByText("修 bug").length).toBeGreaterThan(0);
  });
});

// R13：「对话」页每条会话行的时间是**最后活动时间**，不是关注时间。T6 把它移上
// Row1（状态点 + 标题 + 相对时间）。
describe("对话页:行上的时间是最后活动时间", () => {
  it("Row1 渲染会话的 updatedAt,而不是 followed_at", async () => {
    const lastActive = 1754800000000;
    stubChat(
      [{ fp: "fp-1", sid: 42, followedAt: 1000 }],
      [{ ...summary, updatedAt: lastActive }],
    );

    renderChat();

    await screen.findAllByText("重构登录页");
    // Row1 的时间是会话的最后活动时间（updatedAt），不是 followed_at=1000。
    const expected = formatRelativeTime(lastActive, "en");
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(screen.queryByText(formatRelativeTime(1000, "en"))).toBeNull();
  });
});

describe("对话页:R20 重复会话合并", () => {
  const desktop = {
    id: 3,
    name: "工作 MacBook",
    kind: "desktop",
    fingerprint: "fp-desktop",
    last_seen_at: 1754000000000,
    status: 1,
    online: true,
  };

  function duplicateFollows() {
    return [
      {
        device_fingerprint: "fp-agentred",
        session_id: "42",
        followed_at: 1754000000000,
        invalid: false,
      },
      {
        device_fingerprint: "fp-desktop",
        session_id: "42",
        followed_at: 1754000000000,
        invalid: false,
      },
    ];
  }

  it("同键的桌面端与 agentred 摘要只呈现桌面端完整副本", async () => {
    const compute = {
      ...agentred,
      fingerprint: "fp-agentred",
    };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows") return { items: duplicateFollows() };
      if (path === "/v1/devices") return { devices: [compute, desktop] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockImplementation((fingerprint) => ({
      ...connectedRelay(),
      client: {
        ...fakeClient,
        request: vi.fn(async () => ({
          sessions: [
            {
              ...summary,
              peerFingerprint: "fp-desktop",
              title:
                fingerprint === "fp-desktop"
                  ? "Complete desktop title"
                  : "Partial agentred title",
            },
          ],
          supportsSessionMetadata: true,
        })),
      } as never,
    }));

    renderChat();

    // 会话在「最近」区与所属 Agent 分组各渲染一次（T6），用 *AllBy 断言合并结果：
    // 只剩桌面端完整副本，没有 agentred 退化副本，也不带历史不完整说明。
    expect(
      (await screen.findAllByText("Complete desktop title")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Partial agentred title")).toBeNull();
    expect(screen.queryByText(/History is incomplete/)).toBeNull();
  });

  it("桌面端副本不在场时退到 agentred，并显示历史不完整说明", async () => {
    const compute = {
      ...agentred,
      fingerprint: "fp-agentred",
    };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows") {
        return { items: [duplicateFollows()[0]] };
      }
      if (path === "/v1/devices") {
        return { devices: [compute, { ...desktop, online: false }] };
      }
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      ...connectedRelay(),
      client: {
        ...fakeClient,
        request: vi.fn(async () => ({
          sessions: [
            {
              ...summary,
              peerFingerprint: "fp-desktop",
              title: "Partial agentred title",
            },
          ],
          supportsSessionMetadata: true,
        })),
      } as never,
    });

    renderChat();

    // 会话在「最近」区与所属 Agent 分组各渲染一次（T6），用 *AllBy 断言合并结果：
    // 桌面端副本不在场时退到 agentred 副本并带历史不完整说明。
    expect(
      (await screen.findAllByText("Partial agentred title")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "History is incomplete — showing only the part retained by agentred.",
      ).length,
    ).toBeGreaterThan(0);
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

    await screen.findAllByText("重构登录页");
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

// T6（p5Orc「优化」）：顶部「最近 · 跨 Agent」扁平区 + 筛选 chips + ↑↓ 键盘导航 +
// 右键菜单。全部是桌面形态（移动端由 chat-mobile.test.tsx 守住另一套）。
describe("对话页:T6 会话列表 UX(最近 / 筛选 / 键盘导航 / 右键菜单)", () => {
  it("顶部「最近 · 跨 Agent」= 跨全部 Agent 取最近 5 条", async () => {
    const s = [
      { ...summary, sessionId: 41, title: "最近一", updatedAt: 1754810000000 },
      { ...summary, sessionId: 42, title: "最近二", updatedAt: 1754808000000 },
      { ...summary, sessionId: 43, title: "最近三", updatedAt: 1754806000000 },
      { ...summary, sessionId: 44, title: "最近四", updatedAt: 1754804000000 },
      { ...summary, sessionId: 45, title: "最近五", updatedAt: 1754802000000 },
      { ...summary, sessionId: 46, title: "最旧六", updatedAt: 1754800000000 },
    ];
    stubChat(
      s.map((x) => ({
        fp: "fp-1",
        sid: x.sessionId,
        followedAt: 1754000000000,
      })),
      s,
    );
    renderChat();

    expect(
      await screen.findByRole("heading", { name: "Recent · Across agents" }),
    ).toBeTruthy();
    // 最近 5 条在「最近」区 + Agent 分组各出现一次。
    for (const title of ["最近一", "最近二", "最近三", "最近四", "最近五"]) {
      await waitFor(() => expect(screen.getAllByText(title).length).toBe(2));
    }
    // 最旧那条只进 Agent 分组,不进「最近」。
    expect(screen.getAllByText("最旧六").length).toBe(1);
  });

  it("筛选 chips:全部/运行中/未读 N;点「运行中」只留运行中的行", async () => {
    const waiting = {
      ...summary,
      sessionId: 42,
      title: "等你批",
      lifecycleState: "running",
      waitingForInput: true,
      updatedAt: 1754800000000,
    };
    const running = {
      ...summary,
      sessionId: 43,
      title: "跑着呢",
      lifecycleState: "running",
      updatedAt: 1754700000000,
    };
    const idle = {
      ...summary,
      sessionId: 44,
      title: "歇着",
      lifecycleState: "idle",
      updatedAt: 1754600000000,
    };
    stubChat(
      [
        { fp: "fp-1", sid: 42, followedAt: 1 },
        { fp: "fp-1", sid: 43, followedAt: 1 },
        { fp: "fp-1", sid: 44, followedAt: 1 },
      ],
      [waiting, running, idle],
    );
    renderChat();

    await screen.findAllByText("等你批");
    // 未读 chip 带计数(只有一条等待输入)。
    const unreadChip = screen.getByTestId("filter-chip-unread");
    expect(unreadChip.textContent).toMatch(/Unread/);
    expect(unreadChip.textContent).toMatch(/1/);

    // 点「运行中」:等输入的与闲置的都收起来(「最近」区一起过滤),运行中的还在。
    fireEvent.click(screen.getByTestId("filter-chip-running"));
    await waitFor(() =>
      expect(screen.getAllByText("跑着呢").length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(screen.queryByText("等你批")).toBeNull());
    await waitFor(() => expect(screen.queryByText("歇着")).toBeNull());

    // 回到「全部」。
    fireEvent.click(screen.getByTestId("filter-chip-all"));
    await waitFor(() =>
      expect(screen.getAllByText("等你批").length).toBeGreaterThan(0),
    );
  });

  it("↑↓ 键盘导航移动选中高亮,Enter 在右栏嵌入选中行的真实详情", async () => {
    const s1 = {
      ...summary,
      sessionId: 42,
      title: "重构登录页",
      updatedAt: 1754800000000,
    };
    const s2 = {
      ...summary,
      sessionId: 43,
      title: "修 bug",
      updatedAt: 1754700000000,
    };
    stubChat(
      [
        { fp: "fp-1", sid: 42, followedAt: 1 },
        { fp: "fp-1", sid: 43, followedAt: 1 },
      ],
      [s1, s2],
    );
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <ThemeProvider>
          <Routes>
            <Route path="/chat" element={<Chat />} />
            <Route
              path="/devices/:deviceId/sessions/:sessionId"
              element={<div data-testid="nav-target">ok</div>}
            />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );

    await screen.findAllByText("重构登录页");
    const nav = screen.getByTestId("chat-list-nav");
    // 每次移动选中都要把目标行滚进视口（jsdom 不实现 scrollIntoView，先垫掉）。
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    nav.focus();
    // 第一次 ↓:选中「最近」区第一条(最活跃的那条)。
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(document.querySelector('[aria-current="true"]')).toBeTruthy();
    // 第二次 ↓:选中第二条。
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    // Enter:右栏嵌入第二条的真实详情(= deviceId 1 / sessionId 43),不导航离开。
    fireEvent.keyDown(nav, { key: "Enter" });
    const embedded = await screen.findByTestId("embedded-session-detail");
    expect(embedded.getAttribute("data-device-id")).toBe("1");
    expect(embedded.getAttribute("data-session-id")).toBe("43");
    expect(embedded.getAttribute("data-form")).toBe("embedded");
    expect(screen.queryByTestId("nav-target")).toBeNull();
  });

  it("↑↓ 键盘导航把选中行滚进视口(长列表不把高亮移出可视区)", async () => {
    const s1 = {
      ...summary,
      sessionId: 42,
      title: "重构登录页",
      updatedAt: 1754800000000,
    };
    const s2 = {
      ...summary,
      sessionId: 43,
      title: "修 bug",
      updatedAt: 1754700000000,
    };
    stubChat(
      [
        { fp: "fp-1", sid: 42, followedAt: 1 },
        { fp: "fp-1", sid: 43, followedAt: 1 },
      ],
      [s1, s2],
    );
    renderChat();

    await screen.findAllByText("重构登录页");
    const nav = screen.getByTestId("chat-list-nav");
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    nav.focus();

    // 两次 ↓ 分别把「最近」区两条选中行滚进视口（block: nearest 不跳动）。
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
    const firstTarget = document.querySelector('[aria-current="true"]');
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
    const secondTarget = document.querySelector('[aria-current="true"]');
    // 两次滚进的是同一行容器里的不同行(第二次的目标行确实现身)。
    expect(secondTarget).not.toBe(firstTarget);
    expect(secondTarget?.getAttribute("data-nav-target")).toBeTruthy();
  });

  it("↑↓ 键盘导航任一时刻只有一行被选中(「最近」区与分组是同一批会话,不得两处同亮)", async () => {
    // 42 / 43 都在「最近 · 跨 Agent」区、又在各自 Agent 分组里出现一次——
    // 导航目标必须去重,否则选中 42 时「最近」区与分组里那一行会同亮,Enter 也
    // 打开的是同一个会话(重复目标)。
    const s1 = {
      ...summary,
      sessionId: 42,
      title: "重构登录页",
      updatedAt: 1754800000000,
    };
    const s2 = {
      ...summary,
      sessionId: 43,
      title: "修 bug",
      updatedAt: 1754700000000,
    };
    const s3 = {
      ...summary,
      sessionId: 44,
      title: "不在最近区的第三条",
      updatedAt: 1754600000000,
    };
    stubChat(
      [
        { fp: "fp-1", sid: 42, followedAt: 1 },
        { fp: "fp-1", sid: 43, followedAt: 1 },
        { fp: "fp-1", sid: 44, followedAt: 1 },
      ],
      [s1, s2, s3],
    );
    renderChat();

    await screen.findAllByText("重构登录页");
    const nav = screen.getByTestId("chat-list-nav");
    // jsdom 不实现 scrollIntoView,先垫掉(既有键盘导航测试同一手法)。
    Element.prototype.scrollIntoView = vi.fn();
    nav.focus();

    // 连按 4 次 ↓:最近区 42/43 → 分组 44(去重后)…… 任一时刻都只能有一行高亮。
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(nav, { key: "ArrowDown" });
      const highlighted = document.querySelectorAll('[aria-current="true"]');
      expect(highlighted.length, `第 ${i + 1} 次 ↓ 后高亮行数`).toBe(1);
    }
    // 三次 ↓ 后落在「不在最近区的第三条」(分组独有),其键与最近区不重复。
    const last = document.querySelector('[aria-current="true"]');
    expect(last?.textContent).toContain("不在最近区的第三条");
  });

  it("会话行右键菜单只放真实后端动作(新标签打开/取消关注),不伪造改名删除", async () => {
    stubChat([{ fp: "fp-1", sid: 42, followedAt: 1 }], [summary]);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderChat();

    const title = (await screen.findAllByText("重构登录页"))[0];
    fireEvent.contextMenu(title);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Open in new tab")).toBeTruthy();
    expect(within(menu).getByText("Unfollow")).toBeTruthy();
    // 改名/删除没有后端支持,一律省略(不伪造假按钮)。
    expect(within(menu).queryByText(/Rename/i)).toBeNull();
    expect(within(menu).queryByText(/Delete/i)).toBeNull();

    fireEvent.click(within(menu).getByText("Open in new tab"));
    expect(openSpy).toHaveBeenCalledWith(
      "/devices/1/sessions/42",
      "_blank",
      "noopener,noreferrer",
    );
    openSpy.mockRestore();

    // 右键菜单里的「取消关注」走同一条 unfollow 端点。
    const title2 = (await screen.findAllByText("重构登录页"))[0];
    fireEvent.contextMenu(title2);
    const menu2 = screen.getByRole("menu");
    fireEvent.click(within(menu2).getByText("Unfollow"));
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
  });

  it("失效行右键菜单只放「移除」(没有新标签/取消关注)", async () => {
    stubChat([{ fp: "fp-1", sid: 42, followedAt: 1, invalid: true }], []);
    renderChat();

    await screen.findByText("Unavailable");
    const removeBtn = screen.getByRole("button", { name: "Remove" });
    fireEvent.contextMenu(removeBtn.closest("div")!);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Remove")).toBeTruthy();
    expect(within(menu).queryByText("Open in new tab")).toBeNull();
    expect(within(menu).queryByText("Unfollow")).toBeNull();
  });

  it("右键菜单是可访问菜单:打开即焦点入首项,↑↓ 在项间移动,Escape 关闭", async () => {
    stubChat([{ fp: "fp-1", sid: 42, followedAt: 1 }], [summary]);
    renderChat();

    const title = (await screen.findAllByText("重构登录页"))[0];
    fireEvent.contextMenu(title);
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.length).toBe(2);

    // 打开即把焦点送进菜单首项(键盘/读屏用户不必再 Tab 一圈)。
    expect(document.activeElement).toBe(items[0]);
    // ↑↓ 在菜单项之间移动(不把事件漏给列表的选中逻辑)。
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    // Escape 关闭菜单。
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("搜索框真实过滤会话行(标题/设备/Agent),不是假交互", async () => {
    const s1 = {
      ...summary,
      sessionId: 42,
      title: "重构登录页",
      updatedAt: 1754800000000,
    };
    const s2 = {
      ...summary,
      sessionId: 43,
      title: "修 bug",
      updatedAt: 1754700000000,
    };
    stubChat(
      [
        { fp: "fp-1", sid: 42, followedAt: 1 },
        { fp: "fp-1", sid: 43, followedAt: 1 },
      ],
      [s1, s2],
    );
    renderChat();

    await screen.findAllByText("重构登录页");
    const search = screen.getByRole("searchbox", {
      name: "Search agents, devices, and records",
    });
    // 输入命中「修 bug」:另一条会话从「最近」与分组两处一起收起。
    fireEvent.change(search, { target: { value: "修 bug" } });
    await waitFor(() => expect(screen.queryByText("重构登录页")).toBeNull());
    expect(screen.getAllByText("修 bug").length).toBeGreaterThan(0);
    // 清空恢复全部。
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() =>
      expect(screen.getAllByText("重构登录页").length).toBeGreaterThan(0),
    );
  });
});
