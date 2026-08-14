/**
 * 新对话发起弹层（R15 / R16 / R17，测试接缝 8 的 web 侧；屏 23 / 24 / 25）：
 *   - R15：派发计划按序逐档给出原因；全部档不可用时不静默失败，逐档摆出来
 *     （「现在选不了」+ 本机跳过 / 未配对 / 离线 / 项目路径缺失）。
 *   - R17：发起前（确认步）就呈现 org / subagent / hook 用不了的说明与原因——不是
 *     等工具调用失败了才报错。
 *   - R16：确认派发成功后立刻关注自己这条（POST /v1/follows），于是它不经用户按
 *     「关注」就出现在「对话」页（名单由既有 Chat 页渲染）。
 *   - Chat 页空态的主动作打开这个弹层。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { dispatchNewConversation, fetchDispatchPlan } from "@/lib/dispatch";
import { ensureWebDevice, getFingerprint } from "@/lib/webDevice";
import { useRelayMachine } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import { type DispatchPlan } from "@/lib/dispatch";
import NewConversationDialog from "@/components/session/NewConversationDialog";
import Chat from "@/pages/Chat";

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
vi.mock("@/lib/webDevice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webDevice")>();
  return { ...actual, ensureWebDevice: vi.fn(), getFingerprint: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockFetchPlan = vi.mocked(fetchDispatchPlan);
const mockDispatch = vi.mocked(dispatchNewConversation);
const mockEnsureWebDevice = vi.mocked(ensureWebDevice);
const mockGetFingerprint = vi.mocked(getFingerprint);
const mockUseRelay = vi.mocked(useRelayMachine);

const agents = [
  {
    sync_id: "agent-1",
    name: "后端 Agent",
    avatar_color: "#3B6896",
    has_available_target: true,
    exec_targets: [
      {
        rank: 1,
        availability: "skipped_for_web",
        current: false,
        is_local_reference: true,
      },
      {
        rank: 2,
        device_name: "公司 Mac mini",
        availability: "available",
        current: true,
        is_local_reference: false,
      },
    ],
  },
];

const pickPlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    { rank: 1, availability: "skipped_for_web", current: false },
    {
      rank: 2,
      device_id: 21,
      device_name: "公司 Mac mini",
      backend_type: "codex",
      availability: "available",
      current: true,
    },
  ],
  chosen: {
    device_fingerprint: "fp-online",
    device_id: 21,
    device_name: "公司 Mac mini",
    backend_type: "codex",
  },
  projects: [{ sync_id: "proj-1", name: "agentre-server", configured: true }],
};

const finalPlan: DispatchPlan = {
  ...pickPlan,
  chosen: {
    device_fingerprint: "fp-online",
    device_id: 21,
    device_name: "公司 Mac mini",
    backend_type: "codex",
    kind: "agentred",
    cwd: "/srv/agentre-server",
  },
};

// R17：目标是桌面端时，发起前如实说明 org / subagent / hook **可用**（真身在桌面端）。
const desktopFinalPlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    {
      rank: 1,
      device_id: 30,
      device_name: "家里 Mac mini",
      backend_type: "claudecode",
      kind: "desktop",
      availability: "available",
      current: true,
    },
  ],
  chosen: {
    device_fingerprint: "fp-desk",
    device_id: 30,
    device_name: "家里 Mac mini",
    backend_type: "claudecode",
    kind: "desktop",
    cwd: "/Users/wyz/agentre-server",
  },
  projects: [{ sync_id: "proj-1", name: "agentre-server", configured: true }],
};

const allUnavailablePlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    { rank: 1, availability: "skipped_for_web", current: false },
    { rank: 2, availability: "unpaired", current: false },
    {
      rank: 3,
      device_id: 20,
      device_name: "书房小主机",
      availability: "offline",
      current: false,
    },
    {
      rank: 4,
      device_id: 21,
      device_name: "公司 Mac mini",
      availability: "project_path_missing",
      current: false,
    },
  ],
  chosen: null,
  projects: [],
};

const webDevice = {
  fingerprint: "fp-web",
  accessToken: "web-jwt",
  deviceId: 9,
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockFetchPlan.mockReset();
  mockDispatch.mockReset();
  mockEnsureWebDevice.mockReset();
  // 默认这台浏览器还没有设备身份：读路径回落账号顺序，且不得为此注册一台。
  mockGetFingerprint.mockReset();
  mockGetFingerprint.mockReturnValue(null);
  mockUseRelay.mockReset();
  mockUseRelay.mockReturnValue({
    client: null,
    relayState: "disconnected",
    webDevice: null,
    webDeviceError: null,
  });
});

function renderDialog(onStarted: () => void = () => {}) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <NewConversationDialog
          open
          onOpenChange={() => {}}
          onStarted={onStarted}
        />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("新对话弹层:R15 派发计划逐档原因", () => {
  it("全部档不可用时逐档给出原因而不是静默失败（屏 24 的「现在选不了」）", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      throw new Error("unexpected: " + path);
    });
    mockFetchPlan.mockResolvedValue(allUnavailablePlan);
    renderDialog();

    fireEvent.click(await screen.findByText("后端 Agent"));

    expect(await screen.findByText("Can't start right now")).toBeTruthy();
    // 逐档原因：本机跳过 / 未配对 / 离线 / 项目路径缺失。
    expect(screen.getByText("Skipped for web dispatch")).toBeTruthy();
    expect(screen.getByText("Not paired")).toBeTruthy();
    expect(screen.getByText("书房小主机")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(
      screen.getByText("Path not configured on this machine"),
    ).toBeTruthy();
    // 没有项目可挑，也就走不到确认步。
    expect(screen.queryByText("agentre-server")).toBeNull();
  });
});

describe("新对话弹层:R17 发起前说明 + R16 派发后自关注", () => {
  it("确认步先呈现三个工具不可用的说明（不是等调用失败），派发成功后立刻关注自己这条", async () => {
    mockedApi.mockImplementation(async (path, init) => {
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      if (path === "/v1/follows" && init?.method === "POST") return {};
      throw new Error("unexpected: " + path);
    });
    mockFetchPlan.mockImplementation(async (_agent, project) =>
      project ? finalPlan : pickPlan,
    );
    mockEnsureWebDevice.mockResolvedValue(webDevice);
    mockDispatch.mockResolvedValue({
      sessionId: 9001,
      deviceId: 21,
      deviceFingerprint: "fp-online",
    });
    const onStarted = vi.fn();
    renderDialog(onStarted);

    // 选 Agent → 选项目。
    fireEvent.click(await screen.findByText("后端 Agent"));
    fireEvent.click(await screen.findByText("agentre-server"));

    // R17：发起前就说明 org / subagent / hook 用不了 + 原因（要桌面端在场）。
    expect(
      await screen.findByText("org / subagent / hook are not available here"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "These three built-in tools live on your desktop app. Web-launched conversations can't use them — start from the desktop app if you need them.",
      ),
    ).toBeTruthy();
    // 屏 25：将运行在机器 · 路径。
    expect(
      screen.getByText("Will run on 公司 Mac mini · /srv/agentre-server"),
    ).toBeTruthy();

    // 说第一句 → 开始。
    const input = screen.getByLabelText("Say the first thing to 后端 Agent");
    fireEvent.change(input, { target: { value: "讲讲这个项目" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({
      plan: finalPlan,
      message: "讲讲这个项目",
      sourceDevice: webDevice,
    });

    // R16：派发成功即自关注（不经用户按「关注」）发生在 dispatchNewConversation
    // 内部（POST /v1/follows，见 dispatch.test.ts 的断言）；这里验证弹层确实走到了
    // 派发这一步，并回调让页面跳详情页。
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith({
        sessionId: 9001,
        deviceId: 21,
        deviceFingerprint: "fp-online",
      }),
    );
  });

  it("目标是桌面端时，确认步如实说明 org / subagent / hook 可用（不是沿用 agentred 的不可用文案）", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      throw new Error("unexpected: " + path);
    });
    mockFetchPlan.mockImplementation(async (_agent, project) =>
      project ? desktopFinalPlan : pickPlan,
    );
    mockEnsureWebDevice.mockResolvedValue(webDevice);
    mockDispatch.mockResolvedValue({
      sessionId: 9002,
      deviceId: 30,
      deviceFingerprint: "fp-desk",
    });
    const onStarted = vi.fn();
    renderDialog(onStarted);

    fireEvent.click(await screen.findByText("后端 Agent"));
    fireEvent.click(await screen.findByText("agentre-server"));

    // R17：目标是桌面端 → org / subagent / hook 可用（真身就在那台机器上）。
    expect(
      await screen.findByText("org / subagent / hook are available here"),
    ).toBeTruthy();
    // 不可用的文案不得出现。
    expect(
      screen.queryByText("org / subagent / hook are not available here"),
    ).toBeNull();
    // 屏 25：将运行在桌面端机器 · 路径。
    expect(
      screen.getByText("Will run on 家里 Mac mini · /Users/wyz/agentre-server"),
    ).toBeTruthy();
  });

  it("不输入第一句时「开始」按钮是禁用的（发出第一条消息之前什么都不会跑）", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      throw new Error("unexpected: " + path);
    });
    mockFetchPlan.mockImplementation(async (_agent, project) =>
      project ? finalPlan : pickPlan,
    );
    renderDialog();

    fireEvent.click(await screen.findByText("后端 Agent"));
    fireEvent.click(await screen.findByText("agentre-server"));

    const start = await screen.findByRole("button", {
      name: "Start conversation",
    });
    expect((start as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("对话页空态主动作", () => {
  it("「开始第一个对话」打开新对话弹层", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/follows") return { items: [] };
      if (path === "/v1/devices") return { devices: [] };
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      throw new Error("unexpected: " + path);
    });
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <ThemeProvider>
          <Routes>
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start your first conversation",
      }),
    );
    // 弹层打开：选 Agent 的标题出现。
    expect(await screen.findByText("Pick an agent")).toBeTruthy();
  });
});

describe("新对话弹层:「当前」标记必须和真派发目标是同一档", () => {
  // 弹层原先取 /v1/workspace/agents 时不带 device_fingerprint，却照样渲染每个
  // Agent 的 current 档：服务端在没有指纹时按账号 sort_order 解析，于是弹层说的
  // 「当前」是**账号顺序的赢家**，而总览页（带指纹）说的是这台浏览器自己的赢家。
  // 同一账号同一时刻两处给出不同答案，其中一处必然与真实派发目标不符。
  it("取 Agent 清单时带上这台浏览器的设备指纹", async () => {
    mockGetFingerprint.mockReturnValue("fp-this-browser");
    mockedApi.mockImplementation(async (path) => {
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      throw new Error("unexpected: " + path);
    });
    renderDialog();

    await screen.findByText("后端 Agent");
    expect(
      mockedApi.mock.calls.some(
        ([path]) =>
          path === "/v1/workspace/agents?device_fingerprint=fp-this-browser",
      ),
    ).toBe(true);
  });

  // 拿不到指纹（没排过序 / 已被解除授权）时不附加空参数，读路径照常回落账号顺序，
  // 更不为了凑一个指纹把这台浏览器注册成设备 —— 打开一个弹层不该多出一台机器。
  it("拿不到指纹时不附加查询参数，也不注册设备", async () => {
    mockEnsureWebDevice.mockRejectedValue(new Error("no device"));
    mockedApi.mockImplementation(async (path) => {
      if (path.startsWith("/v1/workspace/agents")) return { agents };
      throw new Error("unexpected: " + path);
    });
    renderDialog();

    await screen.findByText("后端 Agent");
    expect(
      mockedApi.mock.calls.some(([path]) => path === "/v1/workspace/agents"),
    ).toBe(true);
    expect(mockEnsureWebDevice).not.toHaveBeenCalled();
  });
});
