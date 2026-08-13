/**
 * 设备 → 会话列表页（R4 / R5 / R11 的页面接线）：
 *   - 在线 agentred：连接中继 → 列会话 → 渲染面包屑与分组列表。
 *   - 离线 agentred：进入后表达「机器离线」状态（R11 第 1 类）。
 *   - 本浏览器被解除授权：表达「已解除授权」状态（R11 第 3 类），不再进连接流程。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayMachine } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import { WebDeviceRevokedError } from "@/lib/webDevice";
import DeviceSessions from "@/pages/DeviceSessions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);

const deviceRow = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};

const sessions = [
  {
    sessionId: 42,
    title: "重构登录页",
    agentSyncId: "ag-1",
    cwd: "/home/agent/proj",
    backendType: "claudecode",
    lifecycleState: "running",
    waitingForInput: true,
    latestSeq: 12,
  },
  {
    sessionId: 8,
    cwd: "/var/proj",
    backendType: "codex",
    lifecycleState: "idle",
    latestSeq: 5,
  },
];

const fakeClient = {
  request: vi.fn(async (method: string) => {
    if (method === "runtime.session.list") return { sessions };
    throw new Error("unexpected method: " + method);
  }),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  fakeClient.request.mockClear();
  mockUseRelay.mockReset();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/devices/1/sessions"]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/devices/:deviceId/sessions"
            element={<DeviceSessions />}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("设备会话列表页", () => {
  it("在线机器:列出会话并渲染面包屑与分组列表", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents")
        return { agents: [{ sync_id: "ag-1", name: "后端 Agent" }] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: fakeClient as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    });

    renderPage();

    // 面包屑:机器名 + 在线 + 会话数 + 换机器。
    expect(await screen.findByText("书房小主机")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("2 conversations")).toBeTruthy();
    // 会话列表渲染。
    expect(screen.getByText("重构登录页")).toBeTruthy();
    // 老会话退化形态。
    expect(screen.getByText("/var/proj · codex · Idle")).toBeTruthy();
    // 会话列表通过中继取。
    expect(fakeClient.request).toHaveBeenCalledWith("runtime.session.list");
  });

  it("在线桌面端复用同一套会话列表并消费完整 SessionSummary", async () => {
    const desktop = {
      ...deviceRow,
      id: 1,
      name: "工作 MacBook",
      kind: "desktop",
      fingerprint: "fp-desktop",
    };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [desktop] };
      if (path === "/v1/workspace/agents") {
        return { agents: [{ sync_id: "ag-1", name: "后端 Agent" }] };
      }
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: {
        ...fakeClient,
        request: vi.fn(async () => ({
          sessions: [
            {
              ...sessions[0],
              peerFingerprint: "fp-desktop",
              title: "桌面完整标题",
            },
          ],
          supportsSessionMetadata: true,
        })),
      } as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    });

    renderPage();

    expect(await screen.findByText("桌面完整标题")).toBeTruthy();
    // 桌面端列表等待输入时用状态点 + aria-label 表达（#10 起文字徽标只在移动端）。
    expect(
      screen.getByTestId("session-dot-42").getAttribute("aria-label"),
    ).toBe("Waiting for your input");
    expect(mockUseRelay).toHaveBeenCalledWith("fp-desktop");
    expect(screen.queryByText("Unnamed")).toBeNull();
  });

  it("未运行的桌面端直达列表页时说明打开 Agentre，不借用机器离线措辞", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") {
        return {
          devices: [
            {
              ...deviceRow,
              kind: "desktop",
              fingerprint: "fp-desktop",
              online: false,
            },
          ],
        };
      }
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: null,
      relayState: "disconnected",
      webDevice: null,
      webDeviceError: null,
    });

    renderPage();

    expect(await screen.findByText(/Open Agentre to continue/)).toBeTruthy();
    expect(screen.queryByText(/This machine is offline/)).toBeNull();
    expect(mockUseRelay).not.toHaveBeenCalledWith("fp-desktop");
  });

  // 界面（决策 11 / 帧 45a）：「行尾一个「换机器」入口**就地切换**」——不是把人送回
  // 设备页再从头下钻一次。就地列出账号下的其余目标，选中即换到那台机器的会话列表。
  it("面包屑行尾「换机器」就地列出其余 agentred 并切过去", async () => {
    const other = {
      id: 2,
      name: "公司 Mac mini",
      kind: "agentred",
      fingerprint: "fp-2",
      last_seen_at: 1753000000000,
      status: 1,
      online: false,
    };
    const browser = {
      id: 3,
      name: "Chrome · macOS",
      kind: "web",
      fingerprint: "fp-web",
      last_seen_at: 1754000000000,
      status: 1,
      online: false,
    };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return { devices: [deviceRow, other, browser] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: fakeClient as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    });

    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch machine" }),
    );
    const dialog = await screen.findByRole("dialog");
    // 只列 agentred：浏览器不是可下钻的目标（R3 / 帧 47）。
    expect(within(dialog).queryByText("Chrome · macOS")).toBeNull();
    // 离线的那台就地标明离线（R4：离线不可进入）。
    const offlineItem = within(dialog).getByText("公司 Mac mini");
    expect(offlineItem.closest("button")).toBeNull();
    expect(within(dialog).getByText("Offline")).toBeTruthy();
  });

  it("离线机器:表达「机器离线」而非进入列表", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: false }] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: null,
      relayState: "disconnected",
      webDevice: null,
      webDeviceError: null,
    });

    renderPage();

    expect(await screen.findByRole("alert")).toBeTruthy();
    // 离线文案与最后在线时间。
    expect(screen.getByText(/This machine is offline/)).toBeTruthy();
    // 不进入连接流程(不取会话)。
    expect(fakeClient.request).not.toHaveBeenCalled();
  });

  it("本浏览器被解除授权:表达「已解除授权」", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: null,
      relayState: "disconnected",
      webDevice: null,
      webDeviceError: new WebDeviceRevokedError(),
    });

    renderPage();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/revoked/i)).toBeTruthy();
  });

  // R12：桌面的关注开关在会话列表行尾（帧 45a）。名单是账号级的（R14），因此
  // 页面进入时读一次 /v1/follows，点开关写 /v1/follows(/unfollow)。
  it("行尾关注开关把这一条写进账号级名单", async () => {
    const posted: unknown[] = [];
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/follows" && !init?.method) return { items: [] };
      if (path === "/v1/follows") {
        posted.push(JSON.parse(String(init?.body)));
        return {};
      }
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: fakeClient as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    });

    renderPage();

    const row = await screen.findByTestId("session-row-42");
    within(row).getByRole("button", { name: "Follow" }).click();
    await within(row).findByRole("button", { name: "Unfollow" });
    expect(posted).toEqual([{ device_fingerprint: "fp-1", session_id: "42" }]);
  });

  // 兼容性：未升级的 agentred 不认识 R7 / 决策 8 的那几列，session.list 的应答里
  // 没有 supportsSessionMetadata。此时如实说明该机器需要升级，不静默失败。
  it("未升级的 agentred:如实说明该机器需要升级", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: {
        ...fakeClient,
        // 老 daemon 的应答：没有 supportsSessionMetadata 这个键。
        request: vi.fn(async () => ({ sessions })),
      } as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    });

    renderPage();

    expect(await screen.findByText(/Upgrade agentred/i)).toBeTruthy();
  });

  it("升级过的 agentred:不出现升级提示", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: {
        ...fakeClient,
        request: vi.fn(async () => ({
          sessions,
          supportsSessionMetadata: true,
        })),
      } as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    });

    renderPage();

    expect(await screen.findByText("重构登录页")).toBeTruthy();
    expect(screen.queryByText(/Upgrade agentred/i)).toBeNull();
  });

  // R2 / R11：解除授权后该设备行从 /v1/devices 里消失（那个接口只回 ACTIVE 的行）。
  // 因此「查不到自己」就是被解除授权的信号——按 status 判会永远判不出来。
  it("探测时自己的设备行已不在清单里:判为已被解除授权", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] }; // 没有 fp-web
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/follows") return { items: [] };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockReturnValue({
      client: null,
      relayState: "reconnecting",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    });

    renderPage();

    expect(await screen.findByText(/revoked/i)).toBeTruthy();
  });
});
