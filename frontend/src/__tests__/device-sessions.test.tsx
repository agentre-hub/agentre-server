/**
 * 设备 → 会话列表页（R4 / R5 / R11 的页面接线）：
 *   - 在线 agentred：连接中继 → 列会话 → 渲染面包屑与分组列表。
 *   - 离线 agentred：进入后表达「机器离线」状态（R11 第 1 类）。
 *   - 本浏览器被解除授权：表达「已解除授权」状态（R11 第 3 类），不再进连接流程。
 */
import { render, screen } from "@testing-library/react";
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
});
