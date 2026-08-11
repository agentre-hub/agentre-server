import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine, type UseRelayMachineResult } from "@/hooks/use-relay";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";
import Overview from "@/pages/Overview";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);

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
