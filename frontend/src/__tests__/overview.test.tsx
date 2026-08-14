import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine, type UseRelayMachineResult } from "@/hooks/use-relay";
import { ThemeProvider } from "@/lib/theme";
import { ensureWebDevice, getFingerprint } from "@/lib/webDevice";
import i18n from "@/i18n";
import Overview from "@/pages/Overview";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));
vi.mock("@/lib/webDevice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webDevice")>();
  return { ...actual, ensureWebDevice: vi.fn(), getFingerprint: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);
const mockEnsureWebDevice = vi.mocked(ensureWebDevice);
const mockGetFingerprint = vi.mocked(getFingerprint);

const fakeClient = {
  request: vi.fn(),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

function connectedRelay(client: unknown): UseRelayMachineResult {
  return {
    client: client as never,
    relayState: "connected",
    webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
    webDeviceError: null,
  };
}

function disconnectedRelay(): UseRelayMachineResult {
  return {
    client: null,
    relayState: "disconnected",
    webDevice: null,
    webDeviceError: null,
  };
}

function renderOverview() {
  return render(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  // 默认中继未连：只有显式设置 connectedRelay 的用例才挂得到等待会话。
  mockUseRelay.mockReturnValue(disconnectedRelay());
  fakeClient.request.mockReset();
  // 默认这台浏览器还没有设备身份（没排过序 / 已被解除授权）：链按账号顺序读。
  // 打开这一页不得注册出一台设备，所以默认让 ensureWebDevice 一被调用就失败 ——
  // 谁在读路径上碰了它，用例当场就红。要排序的用例自己给一台。
  mockGetFingerprint.mockReset();
  mockGetFingerprint.mockReturnValue(null);
  mockEnsureWebDevice.mockReset();
  mockEnsureWebDevice.mockRejectedValue(new Error("no web device"));
});

describe("overview page", () => {
  it("lists agents with ordered exec targets, the current one, and per-target reasons", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") {
        return {
          agents: [
            {
              sync_id: "agent-1",
              name: "Frontend Agent",
              department_name: "Engineering",
              has_available_target: true,
              exec_targets: [
                {
                  rank: 1,
                  is_local_reference: true,
                  availability: "skipped_for_web",
                  current: false,
                },
                {
                  rank: 2,
                  is_local_reference: false,
                  device_id: 20,
                  device_name: "Study NUC",
                  backend_type: "claude_code",
                  availability: "offline",
                  current: false,
                },
                {
                  rank: 3,
                  is_local_reference: false,
                  device_id: 21,
                  device_name: "Office Mac mini",
                  backend_type: "codex",
                  availability: "available",
                  current: true,
                },
              ],
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderOverview();

    expect(await screen.findByText("Frontend Agent")).toBeTruthy();
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(
      screen.getByText(/Currently running on Office Mac mini/),
    ).toBeTruthy();

    expect(screen.getByText("Skipped for web dispatch")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Study NUC/)).toBeTruthy();

    // 「Office Mac mini」出现两处：「当前落到」那句摘要，以及执行目标链里的
    // 那个 chip。「当前生效」那一档要能从视觉上区分出来（不只是靠颜色）——
    // 断言链里那个 chip 携带一个可查询的 current 标记，而不是只看 CSS 类名。
    const matches = screen.getAllByText(/Office Mac mini/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const currentChip = matches
      .map((el) => el.closest('[data-current="true"]'))
      .find(Boolean);
    expect(currentChip).toBeTruthy();
  });

  it("shows the no-available-target banner when an agent has none", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") {
        return {
          agents: [
            {
              sync_id: "agent-2",
              name: "QA Agent",
              has_available_target: false,
              exec_targets: [
                {
                  rank: 1,
                  is_local_reference: false,
                  backend_type: "claude_code",
                  availability: "unpaired",
                  current: false,
                },
              ],
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderOverview();

    expect(await screen.findByText("QA Agent")).toBeTruthy();
    expect(screen.getByText("No available execution target")).toBeTruthy();
    expect(screen.getByText("Not paired")).toBeTruthy();
  });

  it("shows the empty state when the account has no agents", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected call: " + path);
    });

    renderOverview();

    expect(await screen.findByText("No agents yet.")).toBeTruthy();
  });

  it("reports a load failure instead of rendering the empty state", async () => {
    mockedApi.mockImplementation(async () => {
      throw new SyntaxError("Unexpected token '<' ... is not valid JSON");
    });

    renderOverview();

    expect(
      await screen.findByText("Could not load your agents. Please try again."),
    ).toBeTruthy();
    expect(screen.queryByText("No agents yet.")).toBeNull();
  });

  // R19 守卫：即便 API 响应里意外混进了路径/CLIPath/EnvJSON 形状的字段
  // （生产环境本不该发生——这里模拟的是「万一后端回归」），页面渲染出的文本里
  // 也绝不能出现它们。这道断言钉的是渲染输出，而不是信任后端已经把关。
  it("never renders a path, cli_path or env_json value even if the response carries one", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") {
        return {
          agents: [
            {
              sync_id: "agent-3",
              name: "Ops Agent",
              has_available_target: true,
              exec_targets: [
                {
                  rank: 1,
                  is_local_reference: false,
                  device_id: 20,
                  device_name: "Study NUC",
                  backend_type: "claude_code",
                  availability: "available",
                  current: true,
                  // 下面三个字段真实的 API 从不会发；这里故意塞进去，
                  // 断言组件即便拿到了也绝不会把它们画出来。
                  path: "/Users/wyz/secret-project",
                  cli_path: "/usr/local/bin/claude",
                  env_json: '{"OPENAI_API_KEY":"sk-super-secret"}',
                },
              ],
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    const { container } = renderOverview();
    await waitFor(() => expect(screen.getByText("Ops Agent")).toBeTruthy());

    const text = container.textContent ?? "";
    expect(text).not.toContain("/Users/wyz");
    expect(text).not.toContain("/usr/local/bin/claude");
    expect(text).not.toContain("sk-super-secret");
    expect(text).not.toContain("cli_path");
    expect(text).not.toContain("env_json");
  });
});

// ── 屏 40 对齐（设计稿：4 统计卡 + 琥珀「等你处理」操作条 + 双栏）。 ──────
// 诚实空态：今日用量 / 异常 / 最近授权 / 本月用量 / 安全与审计都没有数据源，
// 只能渲染真实布局 + 空态（—），绝不编造数字；等你处理来自关注会话/中继。
// Agent 卡（执行目标链）是设计稿左栏的 Agent 卡，与 workspace-sync 规格 R19 一致，
// 结构由上面的既有用例守卫，这里不再重复。
describe("overview: 屏 40 统计卡 / 操作条 / 双栏", () => {
  const desktopDevices = [
    {
      id: 1,
      name: "Home NUC",
      kind: "agentred",
      fingerprint: "fp-1",
      online: true,
    },
    {
      id: 2,
      name: "Office Mac mini",
      kind: "agentred",
      fingerprint: "fp-2",
      online: false,
    },
    {
      id: 3,
      name: "This Browser",
      kind: "web",
      fingerprint: "fp-web",
      online: true,
    },
  ];

  const agents = [
    {
      sync_id: "ag-1",
      name: "Backend Agent",
      avatar_color: "#4f46e5",
      has_available_target: true,
      exec_targets: [],
    },
  ];
  const waitingSummary = {
    sessionId: 42,
    title: "Refactor login",
    agentSyncId: "ag-1",
    cwd: "/home/agent/proj",
    backendType: "claudecode",
    lifecycleState: "waiting",
    waitingForInput: true,
    latestSeq: 2,
    updatedAt: Date.now() - 5 * 60000,
  };

  it("TopBar：title 用 nav.overview；Fresh 仅桌面已连（有在线 agentred）时渲染", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/devices") return { devices: desktopDevices };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderOverview();
    expect(
      (await screen.findAllByText("Overview")).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Desktop connected")).toBeTruthy();
  });

  it("Fresh：没有在线 agentred 时不渲染「桌面端已连接」", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 2,
              name: "Office Mac mini",
              kind: "agentred",
              fingerprint: "fp-2",
              online: false,
            },
            {
              id: 3,
              name: "This Browser",
              kind: "web",
              fingerprint: "fp-web",
              online: true,
            },
          ],
        };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderOverview();
    await screen.findByText("Issues");
    expect(screen.queryByText("Desktop connected")).toBeNull();
  });

  it("4 统计卡：真实在线数 + 无数据区块走诚实空态（—），不编数字", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/devices") return { devices: desktopDevices };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    // 四张统计卡都在。
    expect(await screen.findByText("Devices online")).toBeTruthy();
    expect(screen.getByText("Waiting on you")).toBeTruthy();
    expect(screen.getByText("Used today")).toBeTruthy();
    expect(screen.getByText("Issues")).toBeTruthy();

    // 设备在线 = 真实 /v1/devices 在线数（浏览器自身不算机器）。
    expect(
      within(screen.getByTestId("tile-online")).getByText("1"),
    ).toBeTruthy();
    // 副行：第一个离线机器名。
    expect(screen.getByText(/Office Mac mini is offline/)).toBeTruthy();

    // 无关注会话 → 等你处理 = 0（真实可判定）。
    expect(
      within(screen.getByTestId("tile-waiting")).getByText("0"),
    ).toBeTruthy();

    // 今日用量 / 异常没有后端数据源 → 空态（—），不编数字。
    expect(
      within(screen.getByTestId("tile-usage")).getByText("—"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-errors")).getByText("—"),
    ).toBeTruthy();

    // 双栏里无数据源的卡片：真实布局 + 空态。
    expect(screen.getByText("Recent authorizations & changes")).toBeTruthy();
    expect(screen.getByText("All audit →")).toBeTruthy();
    expect(screen.getByText("Usage this month")).toBeTruthy();
    expect(screen.getByText("Security & audit")).toBeTruthy();
    expect(screen.getByText("Go to audit →")).toBeTruthy();

    // 无等待会话 → 操作条整条不渲染。
    expect(screen.queryByText("All conversations →")).toBeNull();
  });

  it("ActionStrip：连上中继且有关注会话等待输入时渲染操作条与卡，动作来自 pendingWaiters", async () => {
    fakeClient.request.mockImplementation(async (method: string) => {
      if (method === "runtime.session.list")
        return { sessions: [waitingSummary] };
      if (method === "runtime.session.pendingWaiters")
        return {
          toolPermissions: [{ RequestID: "req-1", ToolName: "Bash" }],
          askUserQuestions: [],
        };
      throw new Error("unexpected method: " + method);
    });
    mockUseRelay.mockReturnValue(connectedRelay(fakeClient));
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents };
      if (path === "/v1/devices") return { devices: [desktopDevices[0]] };
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1,
              invalid: false,
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    // 操作条头：标题（count=1）+ 副文 + 全部会话链接。
    expect(await screen.findByText("1 waiting on you")).toBeTruthy();
    expect(screen.getByText("All conversations →")).toBeTruthy();
    expect(
      screen.getByText(/Longest waited 5 min — auto-suspends on timeout/),
    ).toBeTruthy();

    // 卡：标题 + 路径副行 + Agent 名 + 来自 tool permission 的 Allow/Deny。
    expect(screen.getByText("Refactor login")).toBeTruthy();
    expect(screen.getByText("/home/agent/proj")).toBeTruthy();
    // Agent 名同时出现在 Agent 卡与操作条卡，用 getAllByText。
    expect(screen.getAllByText("Backend Agent").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getByText("Allow")).toBeTruthy();
    expect(screen.getByText("Deny")).toBeTruthy();
    expect(screen.getByText("View details")).toBeTruthy();

    // 等你处理统计卡 = 真实等待数 1。
    expect(
      within(screen.getByTestId("tile-waiting")).getByText("1"),
    ).toBeTruthy();
    expect(screen.getByText("Longest waited 5 min")).toBeTruthy();
  });

  it("连不到中继：等你处理不显示数字（空态），ActionStrip 不渲染", async () => {
    // 机器在线但中继连不上（relayState=disconnected）：等待数不可知 → 空态，不编 0。
    mockUseRelay.mockReturnValue(disconnectedRelay());
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents };
      if (path === "/v1/devices") return { devices: [desktopDevices[0]] };
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1,
              invalid: false,
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    renderOverview();
    await screen.findByText("Waiting on you");
    expect(
      within(screen.getByTestId("tile-waiting")).getByText("—"),
    ).toBeTruthy();
    expect(screen.queryByText("All conversations →")).toBeNull();
  });
});

// ── task 3：共享组件契约 / 移动·桌面重排 / 真实 waiter 动作 ──────────────────
// 目标：总览忠实对齐 IhldU 层级；无数据源区块用共享 Metric(—) / EmptyState；
// 待处理动作只来自真实 pendingWaiters；移动端重排且无横向溢出。
describe("overview: task 3 共享组件契约 / 重排 / 真实 waiter", () => {
  const machineDevices = [
    {
      id: 1,
      name: "Home NUC",
      kind: "agentred",
      fingerprint: "fp-1",
      online: true,
    },
    {
      id: 2,
      name: "Office Mac mini",
      kind: "agentred",
      fingerprint: "fp-2",
      online: false,
    },
    {
      id: 3,
      name: "This Browser",
      kind: "web",
      fingerprint: "fp-web",
      online: true,
    },
  ];

  // 本地副本：与「屏 40」describe 同名但各自作用域，避免跨块引用。
  const agentSummary = {
    sync_id: "ag-1",
    name: "Backend Agent",
    avatar_color: "#4f46e5",
    has_available_target: true,
    exec_targets: [],
  };
  const waitingSummary = {
    sessionId: 42,
    title: "Refactor login",
    agentSyncId: "ag-1",
    cwd: "/home/agent/proj",
    backendType: "claudecode",
    lifecycleState: "waiting",
    waitingForInput: true,
    latestSeq: 2,
    updatedAt: Date.now() - 5 * 60000,
  };

  it("4 统计卡由共享 Metric 渲染；设备在线展示真实在线/总数", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/devices") return { devices: machineDevices };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    await screen.findByText("Devices online");
    // 四张卡都长在共享 Metric 上（metric-value 是共享组件的内部标记）。
    for (const id of [
      "tile-online",
      "tile-waiting",
      "tile-usage",
      "tile-errors",
    ]) {
      const tile = screen.getByTestId(id);
      expect(tile.querySelector('[data-testid="metric-value"]')).toBeTruthy();
    }
    // 设备在线 = 1 台在线机器 / 共 2 台机器（浏览器 web 不算机器）。
    expect(
      within(screen.getByTestId("tile-online")).getByText("1"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-online")).getByText("/ 2"),
    ).toBeTruthy();
  });

  it("无数据源区块使用共享 EmptyState，不编样本时间/IP/数字", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    await screen.findByText("Recent authorizations & changes");
    // 最近授权 / 本月用量 / 安全与审计都长在共享 EmptyState（empty-icon 是内部标记）。
    for (const id of ["empty-recent-auth", "empty-usage", "empty-security"]) {
      const es = screen.getByTestId(id);
      expect(es.querySelector('[data-testid="empty-icon"]')).toBeTruthy();
    }
    // 空态里绝无设计示例的时钟/IP/令牌数字。
    const recentText =
      screen.getByTestId("empty-recent-auth").textContent ?? "";
    expect(recentText).not.toMatch(/\d{1,2}:\d{2}/); // 无示例时间 13:47 / 18:24
    const securityText = screen.getByTestId("empty-security").textContent ?? "";
    expect(securityText).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/); // 无示例 IP 192.168.1.12
  });

  it("Agent 主区无 Agent 时也用共享 EmptyState", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    await screen.findByText("No agents yet.");
    const es = screen.getByTestId("empty-agents");
    expect(es.querySelector('[data-testid="empty-icon"]')).toBeTruthy();
  });

  it("待处理动作只来自真实 waiter：pendingWaiters 为空时卡上只有看详情，无假动作", async () => {
    // 中继连上、有一条关注会话在等输入，但 pendingWaiters 返回空——
    // 没有任何可执行的允许/拒绝/回复，卡上只能留下真实的「看详情」。
    fakeClient.request.mockImplementation(async (method: string) => {
      if (method === "runtime.session.list")
        return { sessions: [waitingSummary] };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected method: " + method);
    });
    mockUseRelay.mockReturnValue(connectedRelay(fakeClient));
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [agentSummary] };
      if (path === "/v1/devices") return { devices: [machineDevices[0]] };
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1,
              invalid: false,
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    expect(await screen.findByText("1 waiting on you")).toBeTruthy();
    expect(screen.getByText("Refactor login")).toBeTruthy();
    expect(screen.getByText("View details")).toBeTruthy();
    // 没有任何 waiter → 不允许/拒绝/去回复这些假动作出现。
    expect(screen.queryByText("Allow")).toBeNull();
    expect(screen.queryByText("Deny")).toBeNull();
    expect(screen.queryByText("Reply")).toBeNull();
  });

  it("移动/桌面重排无横向溢出：统计 2 列→4 列，双栏纵向→横向，辅助区满宽→340px", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/devices") return { devices: machineDevices };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    renderOverview();
    await screen.findByText("Devices online");

    // 统计卡：移动 2 列，桌面 4 列（不是等比缩小）。
    const tiles = screen.getByTestId("overview-tiles");
    expect(tiles.className).toContain("grid-cols-2");
    expect(tiles.className).toContain("md:grid-cols-4");
    // 双栏：移动纵向堆叠，lg 才并排。
    const cols = screen.getByTestId("overview-cols");
    expect(cols.className).toContain("flex-col");
    expect(cols.className).toContain("lg:flex-row");
    // 辅助区：移动占满宽度，lg 才收成 340px。
    const aside = screen.getByTestId("overview-aside");
    expect(aside.className).toContain("w-full");
    expect(aside.className).toContain("lg:w-[340px]");
  });
});

// ── 跨机器同号会话的 waiters 隔离 ────────────────────────────────────────
// 会话 id 是 daemon 局部计数：两台 agentred 完全可以各自有一条 42 号会话。
// 操作条卡的等待数据按「机器 + 会话」区分，不能只按 sessionId 记 —— 否则两台
// 机器同号等待会话时，后到的那台会把自己的 waiters 覆盖掉先到那台的同号槽位，
// 卡上的 Allow/Deny 提交到**另一台**机器上（RequestID 也是 daemon 局部的，
// 拿 A 机的 requestId 提交到 B 机 = 批准/拒绝错对象）。
describe("overview: 跨机器同号会话的 waiters 隔离", () => {
  it("两台机器各有同号(42)的等待会话：每张卡的 Allow 各提交各机器的 RequestID", async () => {
    const devA = {
      id: 1,
      name: "机器A",
      kind: "agentred",
      fingerprint: "fp-1",
      online: true,
    };
    const devB = {
      id: 2,
      name: "机器B",
      kind: "agentred",
      fingerprint: "fp-2",
      online: true,
    };
    const agents = [
      {
        sync_id: "ag-1",
        name: "后端 Agent",
        avatar_color: "#4f46e5",
        has_available_target: true,
        exec_targets: [],
      },
    ];
    const summary42 = {
      sessionId: 42,
      title: "两机同号会话",
      agentSyncId: "ag-1",
      cwd: "/home/agent/proj",
      backendType: "claudecode",
      lifecycleState: "running",
      waitingForInput: true,
      latestSeq: 2,
      updatedAt: Date.now() - 60000,
    };
    // 两台机器各带不同的 RequestID：B 的请求必须提交到 B 的中继、用 B 的 id。
    const clientA = {
      request: vi.fn(async (method: string, _params?: unknown) => {
        if (method === "runtime.session.list") return { sessions: [summary42] };
        if (method === "runtime.session.pendingWaiters")
          return {
            toolPermissions: [{ RequestID: "req-A", ToolName: "Bash" }],
            askUserQuestions: [],
          };
        if (method === "runtime.submitToolPermission") return {};
        throw new Error("unexpected: " + method);
      }),
      attach: vi.fn(),
      catchUp: vi.fn(),
      close: vi.fn(),
    };
    const clientB = {
      request: vi.fn(async (method: string, _params?: unknown) => {
        if (method === "runtime.session.list") return { sessions: [summary42] };
        if (method === "runtime.session.pendingWaiters")
          return {
            toolPermissions: [{ RequestID: "req-B", ToolName: "Write" }],
            askUserQuestions: [],
          };
        if (method === "runtime.submitToolPermission") return {};
        throw new Error("unexpected: " + method);
      }),
      attach: vi.fn(),
      catchUp: vi.fn(),
      close: vi.fn(),
    };
    mockUseRelay.mockImplementation((fp: string | null) =>
      connectedRelay(fp === "fp-1" ? clientA : clientB),
    );
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents };
      if (path === "/v1/devices") return { devices: [devA, devB] };
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1,
              invalid: false,
            },
            {
              device_fingerprint: "fp-2",
              session_id: "42",
              followed_at: 1,
              invalid: false,
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    // 两张等待卡都渲染（两台机器各一条同号等待会话）。
    expect(await screen.findByText("2 waiting on you")).toBeTruthy();
    const allowButtons = screen.getAllByRole("button", { name: "Allow" });
    expect(allowButtons.length).toBe(2);

    // 第一张卡（fp-1）的 Allow：提交到 fp-1 的中继，带 fp-1 的 RequestID。
    fireEvent.click(allowButtons[0]);
    await waitFor(() => {
      const call = clientA.request.mock.calls.find(
        (c) => c[0] === "runtime.submitToolPermission",
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({ sessionId: 42, requestId: "req-A" });
    });

    // 第二张卡（fp-2）的 Allow：提交到 fp-2 的中继，带 fp-2 的 RequestID。
    fireEvent.click(allowButtons[1]);
    await waitFor(() => {
      const call = clientB.request.mock.calls.find(
        (c) => c[0] === "runtime.submitToolPermission",
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({ sessionId: 42, requestId: "req-B" });
    });
  });

  // Allow 提交后的收敛：submitToolDecision 重查 pendingWaiters 后，刷新结果必须
  // 落回「机器:会话」同号槽位。写错键（只按 sessionId）的话，卡上那格 stale 的
  // 待决策永远不消失——用户点了 Allow，卡片却仍挂着 Allow/Deny（已处理的动作）。
  it("Allow 提交后刷新结果落回同机同号槽位：已处理的待决策从卡上收敛掉", async () => {
    const devA = {
      id: 1,
      name: "机器A",
      kind: "agentred",
      fingerprint: "fp-1",
      online: true,
    };
    const agents = [
      {
        sync_id: "ag-1",
        name: "后端 Agent",
        avatar_color: "#4f46e5",
        has_available_target: true,
        exec_targets: [],
      },
    ];
    const summary42 = {
      sessionId: 42,
      title: "单机等待会话",
      agentSyncId: "ag-1",
      cwd: "/home/agent/proj",
      backendType: "claudecode",
      lifecycleState: "running",
      waitingForInput: true,
      latestSeq: 2,
      updatedAt: Date.now() - 60000,
    };
    let pendingCalls = 0;
    const clientA = {
      request: vi.fn(async (method: string) => {
        if (method === "runtime.session.list") return { sessions: [summary42] };
        if (method === "runtime.session.pendingWaiters") {
          pendingCalls += 1;
          // 第一次：有一条待批准；Allow 提交后的重查：已被处理，返回空。
          return pendingCalls === 1
            ? {
                toolPermissions: [{ RequestID: "req-A", ToolName: "Bash" }],
                askUserQuestions: [],
              }
            : { toolPermissions: [], askUserQuestions: [] };
        }
        if (method === "runtime.submitToolPermission") return {};
        throw new Error("unexpected: " + method);
      }),
      attach: vi.fn(),
      catchUp: vi.fn(),
      close: vi.fn(),
    };
    mockUseRelay.mockReturnValue(connectedRelay(clientA));
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents };
      if (path === "/v1/devices") return { devices: [devA] };
      if (path === "/v1/follows")
        return {
          items: [
            {
              device_fingerprint: "fp-1",
              session_id: "42",
              followed_at: 1,
              invalid: false,
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    renderOverview();

    // 等待卡渲染，Allow 在卡上。
    expect(await screen.findByText("单机等待会话")).toBeTruthy();
    expect(screen.getByText("Allow")).toBeTruthy();

    fireEvent.click(screen.getByText("Allow"));

    // Allow 提交后重查 pendingWaiters（空）：已处理的待决策不应再渲染 Allow/Deny。
    // 卡仍保留（有真实会话），只剩「看详情」。
    await waitFor(() => {
      expect(screen.queryByText("Allow")).toBeNull();
    });
    expect(screen.queryByText("Deny")).toBeNull();
    expect(screen.getByText("View details")).toBeTruthy();
  });
});

// ── 这个浏览器自己的派发顺序（决策 10 / 11） ─────────────────────────────
// Agent 卡上的执行目标链每一档给出上移 / 下移：一次移动即提交
// POST /v1/workspace/exec-target-order（backend sync_id 排列 + 本机指纹），
// 随后重新拉取该 Agent 的链，「当前」标记当场跟着改变。
// skipped_for_web 的档（浏览器语境下永不可派发）只读、不可移动，仍留在链里。
describe("overview: 这个浏览器自己的派发顺序", () => {
  const webDevice = { fingerprint: "fp-web", accessToken: "t", deviceId: 9 };
  const AGENTS_PATH = "/v1/workspace/agents?device_fingerprint=fp-web";
  const ORDER_PATH = "/v1/workspace/exec-target-order";

  const tierById: Record<string, Record<string, unknown>> = {
    "b-local": {
      backend_sync_id: "b-local",
      is_local_reference: true,
      availability: "skipped_for_web",
    },
    "b-nuc": {
      backend_sync_id: "b-nuc",
      is_local_reference: false,
      device_id: 20,
      device_name: "Study NUC",
      backend_type: "claude_code",
      availability: "available",
    },
    "b-mac": {
      backend_sync_id: "b-mac",
      is_local_reference: false,
      device_id: 21,
      device_name: "Office Mac mini",
      backend_type: "codex",
      availability: "available",
    },
  };

  /** 一个 Agent 的链：order 是这台浏览器看到的次序，current 落在第一个可用档。 */
  function agentChain(order: string[]) {
    const firstAvailable = order.find((id) => id !== "b-local");
    return {
      sync_id: "ag-1",
      name: "Backend Agent",
      has_available_target: true,
      exec_targets: order.map((id, i) => ({
        ...tierById[id],
        rank: i + 1,
        current: id === firstAvailable,
      })),
    };
  }

  function chipTexts(): string[] {
    return screen
      .getAllByTestId("exec-target")
      .map((el) => el.textContent ?? "");
  }

  function chipOf(name: RegExp): HTMLElement {
    const chip = screen
      .getAllByText(name)
      .map((el) => el.closest('[data-testid="exec-target"]'))
      .find(Boolean);
    if (!chip) throw new Error("no exec target chip for " + name);
    return chip as HTMLElement;
  }

  it("每一档给出上移/下移；skipped_for_web 档只读、不可移动", async () => {
    mockGetFingerprint.mockReturnValue(webDevice.fingerprint);
    mockedApi.mockImplementation(async (path) => {
      if (path === AGENTS_PATH)
        return { agents: [agentChain(["b-local", "b-nuc", "b-mac"])] };
      throw new Error("unexpected: " + path);
    });

    renderOverview();
    await screen.findByText("Backend Agent");

    // 链按**这台浏览器**的顺序读：读端点带上本机指纹。
    expect(mockedApi).toHaveBeenCalledWith(AGENTS_PATH);

    // 两个可移动档各有一对上移/下移；本机档一个都没有（决策 11）。
    const ups = screen.getAllByRole("button", { name: "Move up" });
    const downs = screen.getAllByRole("button", { name: "Move down" });
    expect(ups.length).toBe(2);
    expect(downs.length).toBe(2);
    expect(
      chipOf(/Skipped for web dispatch/).querySelectorAll("button").length,
    ).toBe(0);

    // 端点方向禁用：第一个可移动档不能再上移，最后一个不能再下移。
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    expect((downs[downs.length - 1] as HTMLButtonElement).disabled).toBe(true);
    expect((ups[1] as HTMLButtonElement).disabled).toBe(false);
    expect((downs[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("一次移动即提交并重新拉取该 Agent 的链，「当前」标记随之更新", async () => {
    mockGetFingerprint.mockReturnValue(webDevice.fingerprint);
    mockEnsureWebDevice.mockResolvedValue(webDevice);
    let agentsCalls = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path === AGENTS_PATH) {
        agentsCalls += 1;
        return {
          agents: [
            agentChain(
              agentsCalls === 1
                ? ["b-local", "b-nuc", "b-mac"]
                : ["b-local", "b-mac", "b-nuc"],
            ),
          ],
        };
      }
      if (path === ORDER_PATH) return {};
      throw new Error("unexpected: " + path);
    });

    renderOverview();
    await screen.findByText(/Currently running on Study NUC/);

    fireEvent.click(
      within(chipOf(/Office Mac mini/)).getByRole("button", {
        name: "Move up",
      }),
    );

    // 用户当场看到自己这一下改变了派发目标。
    await waitFor(() =>
      expect(
        screen.getByText(/Currently running on Office Mac mini/),
      ).toBeTruthy(),
    );
    expect(chipTexts()[1]).toContain("Office Mac mini");
    // 「当前」标记落到链上被移上来的那一档，不只是那句摘要变了。
    expect(chipOf(/Office Mac mini/).getAttribute("data-current")).toBe("true");

    // 提交的是 backend sync_id 排列 + 这台浏览器的指纹；本机档钉在原位。
    const post = mockedApi.mock.calls.find((c) => c[0] === ORDER_PATH);
    expect(post?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      device_fingerprint: "fp-web",
      agent_sync_id: "ag-1",
      backend_sync_ids: ["b-local", "b-mac", "b-nuc"],
    });
    // 提交之后重新拉了一次该 Agent 的链（不是只改本地状态）。
    expect(agentsCalls).toBe(2);
  });

  it("提交失败保持原顺序并就地说明，不静默", async () => {
    mockGetFingerprint.mockReturnValue(webDevice.fingerprint);
    mockEnsureWebDevice.mockResolvedValue(webDevice);
    let agentsCalls = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path === AGENTS_PATH) {
        agentsCalls += 1;
        return { agents: [agentChain(["b-local", "b-nuc", "b-mac"])] };
      }
      if (path === ORDER_PATH) throw new Error("order save failed");
      throw new Error("unexpected: " + path);
    });

    renderOverview();
    await screen.findByText(/Currently running on Study NUC/);

    fireEvent.click(
      within(chipOf(/Office Mac mini/)).getByRole("button", {
        name: "Move up",
      }),
    );

    // 就地说明（不是只往控制台打日志）。
    expect(
      await screen.findByText(
        "Could not apply the new order. Please try again.",
      ),
    ).toBeTruthy();
    // 顺序原封不动：「当前」仍在原来那一档，链的次序不变，也没有重新拉取。
    expect(screen.getByText(/Currently running on Study NUC/)).toBeTruthy();
    const texts = chipTexts();
    expect(texts[1]).toContain("Study NUC");
    expect(texts[2]).toContain("Office Mac mini");
    expect(agentsCalls).toBe(1);
  });

  // 打开总览页是纯读：它不得把这台浏览器注册成一台设备。否则用户只是看了一眼
  // 控制台，账号的设备列表里就凭空多一台机器 —— e2e 的「真实空态」正是踩在这上面
  // 挂的（新用户打开 /overview 后 /devices 不再是空的）。
  it("打开这一页不注册设备：按账号顺序读，排序控件照常给", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents")
        return { agents: [agentChain(["b-local", "b-nuc", "b-mac"])] };
      throw new Error("unexpected: " + path);
    });

    renderOverview();
    await screen.findByText("Backend Agent");

    // 没有设备身份 → 读端点不带指纹，服务端回落账号顺序。
    expect(mockedApi).toHaveBeenCalledWith("/v1/workspace/agents");
    // 而且一次注册都没发生：读一份偏好不该有建出一台设备行的副作用。
    expect(mockEnsureWebDevice).not.toHaveBeenCalled();
    // 控件照常给：注册在写路径，把控件按身份藏起来会让这台浏览器永远排不了序。
    expect(screen.getAllByRole("button", { name: "Move up" }).length).toBe(2);
  });

  it("第一次排序时才注册这台浏览器，并按注册到的指纹提交与重读", async () => {
    mockEnsureWebDevice.mockResolvedValue(webDevice);
    let accountOrderCalls = 0;
    let deviceOrderCalls = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") {
        accountOrderCalls += 1;
        return { agents: [agentChain(["b-local", "b-nuc", "b-mac"])] };
      }
      if (path === AGENTS_PATH) {
        deviceOrderCalls += 1;
        return { agents: [agentChain(["b-local", "b-mac", "b-nuc"])] };
      }
      if (path === ORDER_PATH) return {};
      throw new Error("unexpected: " + path);
    });

    renderOverview();
    await screen.findByText(/Currently running on Study NUC/);
    expect(mockEnsureWebDevice).not.toHaveBeenCalled();

    fireEvent.click(
      within(chipOf(/Office Mac mini/)).getByRole("button", {
        name: "Move up",
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Currently running on Office Mac mini/),
      ).toBeTruthy(),
    );
    // 排序这一下才把这台浏览器注册成一台设备（顺序的持有者是设备）。
    expect(mockEnsureWebDevice).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        String(
          mockedApi.mock.calls.find((c) => c[0] === ORDER_PATH)?.[1]?.body,
        ),
      ),
    ).toMatchObject({ device_fingerprint: webDevice.fingerprint });
    // 重读走的是刚注册到的那台设备的顺序，不是再按账号顺序读一遍。
    expect(accountOrderCalls).toBe(1);
    expect(deviceOrderCalls).toBe(1);
  });
});
