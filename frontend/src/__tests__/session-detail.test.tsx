/**
 * 会话详情页（R6 / R8 / R9 / R10 的页面接线）：
 *   - attach + 按 seq 游标补齐 → 转录渲染。
 *   - 发新消息 → runtime.run（R9，带 sourceDevice / sourceDeviceName）。
 *   - 批准工具调用 → runtime.submitToolPermission（R10）。
 *   - 待决策已被别的端回答 → 就地说明「已被处理」并刷新状态（R10）。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import {
  useRelayMachine,
  type UseRelayMachineOptions,
} from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import SessionDetail from "@/pages/SessionDetail";

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

const summary = {
  sessionId: 42,
  title: "重构登录页",
  agentSyncId: "ag-1",
  cwd: "/home/agent/proj",
  backendType: "claudecode",
  lifecycleState: "idle",
  latestSeq: 2,
};

let capturedOpts: UseRelayMachineOptions = {};

const fakeClient = {
  request: vi.fn(),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  capturedOpts = {};
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockClear();
});

function renderPage() {
  mockUseRelay.mockImplementation((_fp, opts) => {
    capturedOpts = opts ?? {};
    return {
      client: fakeClient as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    };
  });
  return render(
    <MemoryRouter initialEntries={["/devices/1/sessions/42"]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/devices/:deviceId/sessions/:sessionId"
            element={<SessionDetail />}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("会话详情页", () => {
  it("attach + 补齐后渲染转录", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        sessionId: 42,
        event: { kind: "text_delta", text: "你好" },
        seq: 1,
      });
    });

    renderPage();

    expect(await screen.findByText("你好")).toBeTruthy();
    expect(fakeClient.attach).toHaveBeenCalledWith(42);
    expect(fakeClient.catchUp).toHaveBeenCalledWith(42);
  });

  it("发新消息走 runtime.run 并带来源设备", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === "runtime.run") return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "把按钮改成蓝色" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === "runtime.run",
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({
        sessionId: 42,
        cwd: "/home/agent/proj",
        title: "重构登录页",
        agentSyncId: "ag-1",
        userText: "把按钮改成蓝色",
        sourceDevice: "fp-web",
        // daemon 端按 {"type": ...} 解 backend(integration_test 的既有契约);
        // 这里发的必须与 wire 契约一致,否则 daemon 解出空 backend 报未注册。
        backend: { type: "claudecode" },
      });
    });
  });

  it("实时收到 tool_permission_request 事件后刷新待决策并出现审批卡", async () => {
    // 审批卡的数据源是 pendingWaiters,不是事件流:daemon 实时推来审批事件后页面必须
    // 主动重拉一次,否则卡永远不出现(fake runtime 阻塞在审批上,run 不会结束,
    // onRunResultDone 那一条刷新路径到不了)。
    let waitersCall = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters") {
        waitersCall += 1;
        if (waitersCall === 1) {
          return { toolPermissions: [], askUserQuestions: [] };
        }
        return {
          toolPermissions: [
            { RequestID: "tp-1", ToolName: "Bash", Input: { cmd: "ls" } },
          ],
          askUserQuestions: [],
        };
      }
      throw new Error("unexpected: " + method);
    });

    renderPage();
    expect(await screen.findByText(/重构登录页/)).toBeTruthy();

    // daemon 实时推来 tool_permission_request 事件。
    await act(async () => {
      capturedOpts.onEvent?.({
        sessionId: 42,
        event: {
          kind: "tool_permission_request",
          requestId: "tp-1",
          toolName: "Bash",
          input: { cmd: "ls" },
        },
        seq: 6,
      });
    });

    // 审批卡(可交互)的判据是 DecisionPanel 里的 approve-tool-allow 按钮 ——
    // 转录里的 decision 信息卡是只读的,不能当证据。
    expect(await screen.findByTestId("approve-tool-allow")).toBeTruthy();
    expect(waitersCall).toBeGreaterThanOrEqual(2);
  });

  it("批准工具调用走 runtime.submitToolPermission", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return {
          toolPermissions: [
            { RequestID: "tp-1", ToolName: "Bash", Input: { cmd: "ls" } },
          ],
          askUserQuestions: [],
        };
      if (method === "runtime.submitToolPermission") return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    expect(await screen.findByText("Approve Bash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === "runtime.submitToolPermission",
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({
        sessionId: 42,
        requestId: "tp-1",
        allow: true,
        alwaysAllowSession: false,
      });
    });
  });

  it("待决策已被别的端回答:就地说明已被处理", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    // 第一次 pendingWaiters(渲染卡片)有 tp-1;提交前的预检返回空 → 已被处理。
    let waiterCalls = 0;
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters") {
        waiterCalls += 1;
        if (waiterCalls === 1)
          return {
            toolPermissions: [{ RequestID: "tp-1", ToolName: "Bash" }],
            askUserQuestions: [],
          };
        return { toolPermissions: [], askUserQuestions: [] };
      }
      throw new Error("unexpected: " + method);
    });

    renderPage();
    expect(await screen.findByText("Approve Bash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    // 不报错、不静默:就地说明已被处理。
    expect(
      await screen.findByText("This request has already been handled."),
    ).toBeTruthy();
    // 没有把提交发出去(预检发现已不在)。
    expect(
      fakeClient.request.mock.calls.some(
        (c) => c[0] === "runtime.submitToolPermission",
      ),
    ).toBe(false);
  });
});

// 兼容性 + R9：未升级的 agentred 不认识 R7 / 决策 8 的那几列，续话续不上上下文。
// 如实说明该机器需要升级并停用输入框，而不是让消息静默发出去。
describe("会话详情页:老 agentred 与发送失败", () => {
  it("未升级的 agentred:说明需要升级并停用发送", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      // 老 daemon 的应答：没有 supportsSessionMetadata。
      if (method === "runtime.session.list") return { sessions: [summary] };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });

    renderPage();
    expect(await screen.findByText(/Upgrade agentred/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("发送失败:就地报错,不静默吞掉", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === "runtime.run") throw new Error("boom");
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "把按钮改成蓝色" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/could not be sent/i)).toBeTruthy();
  });
});
