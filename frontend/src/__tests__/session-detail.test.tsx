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
import SessionDetailView from "@/components/session/SessionDetailView";
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
    // 自己发起的会话没有 origin：省略即「调用方自己的对端」。
    expect(fakeClient.attach).toHaveBeenCalledWith(42, undefined);
    expect(fakeClient.catchUp).toHaveBeenCalledWith(42, undefined);
  });

  // R4「列出这台机器上的**全部**会话，无论由哪个对端发起」→ R6「接入一条会话后收到
  // 实时流」→ R9「浏览器可以给一条会话发新消息」。别的对端发起的会话，daemon 上的
  // 会话键是 (发起端指纹, 会话 id)：清单在 summary.peerFingerprint 上交出 origin，
  // 而 ResolveSessionPeer 的入口约定是「省略 = 调用方自己的对端」。不把它原样带回
  // 每一次 attach / pull / 控制请求 / runtime.run，浏览器接的就是它自己名下那条
  // 同号空会话——转录空白、发消息另起一轮，桌面端也收不到（R18 的前提落空）。
  it("别的对端发起的会话:attach / 补齐 / 发消息都带回 origin 指纹", async () => {
    const remote = { ...summary, peerFingerprint: "fp-desktop" };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [remote], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === "runtime.run") return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    // 读路径：attach 与游标补齐都指向发起端那条会话。
    await vi.waitFor(() => {
      expect(fakeClient.attach).toHaveBeenCalledWith(42, "fp-desktop");
      expect(fakeClient.catchUp).toHaveBeenCalledWith(42, "fp-desktop");
    });
    // 待决策快照同样按 origin 问（否则问到的是空会话，审批卡永远不出现）。
    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === "runtime.session.pendingWaiters",
      );
      expect(call?.[1]).toMatchObject({ peerFingerprint: "fp-desktop" });
    });

    // 写路径：这一轮必须落在发起端那条会话上。
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "把按钮改成蓝色" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === "runtime.run",
      );
      expect(call?.[1]).toMatchObject({
        sessionId: 42,
        peerFingerprint: "fp-desktop",
      });
    });
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

describe("会话详情页:提交决策的失败路径", () => {
  // 提交前的预检拉不到待决策(网络抖动 / 一次 RPC 失败)是「没问出来」,不是
  // 「已经被处理」。当成已处理收场会把这次批准静默丢掉——那边的工具还阻塞着,
  // 用户却被告知处理完了。拉不到就照常提交:重复提交由 daemon 幂等收敛(R8)。
  it("预检 RPC 失败时照常提交,不谎报「已被处理」", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
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
        // 预检这一次挂了。
        throw new Error("pendingWaiters unavailable");
      }
      if (method === "runtime.submitToolPermission") return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    expect(await screen.findByText("Approve Bash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await vi.waitFor(() => {
      expect(
        fakeClient.request.mock.calls.some(
          (c) => c[0] === "runtime.submitToolPermission",
        ),
      ).toBe(true);
    });
    expect(screen.queryByText("This request has already been handled.")).toBe(
      null,
    );
  });

  // 提交本身失败(socket 刚断)必须就地说明。不说明的话按钮点下去什么都不发生,
  // 用户以为批准生效了,而工具还阻塞在那台机器上。
  it("提交失败:就地说明,不静默吞掉", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return {
          toolPermissions: [{ RequestID: "tp-1", ToolName: "Bash" }],
          askUserQuestions: [],
        };
      if (method === "runtime.submitToolPermission")
        throw new Error("relay: 连接未就绪");
      throw new Error("unexpected: " + method);
    });

    renderPage();
    expect(await screen.findByText("Approve Bash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(await screen.findByText(/could not be submitted/i)).toBeTruthy();
  });

  // 「已被处理」是对**那一条**待决策的说明,不是页面的永久状态。新的待决策上来
  // 之后它还挂着,就变成了「已被处理」与一张真的等着人批的审批卡并排自相矛盾。
  it("新的待决策上来时清掉上一条的「已被处理」说明", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
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
        // 预检:tp-1 已被别的端答过 → 就地说明已被处理。
        if (waiterCalls === 2)
          return { toolPermissions: [], askUserQuestions: [] };
        // 此后 daemon 又推来一条新的待决策。
        return {
          toolPermissions: [{ RequestID: "tp-2", ToolName: "Write" }],
          askUserQuestions: [],
        };
      }
      if (method === "runtime.submitToolPermission") return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    expect(await screen.findByText("Approve Bash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(
      await screen.findByText("This request has already been handled."),
    ).toBeTruthy();

    await act(async () => {
      capturedOpts.onEvent?.({
        sessionId: 42,
        event: { kind: "tool_permission_request", requestId: "tp-2" },
        seq: 9,
      });
    });

    expect(await screen.findByText("Approve Write")).toBeTruthy();
    await vi.waitFor(() => {
      expect(screen.queryByText("This request has already been handled.")).toBe(
        null,
      );
    });
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

  it("桌面端在场但钉住的 agentred 不可用:历史仍可读、新写入停用并给专门说明", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") {
        return { devices: [{ ...deviceRow, kind: "desktop" }] };
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list") {
        return { sessions: [summary], supportsSessionMetadata: true };
      }
      if (method === "runtime.session.pendingWaiters") {
        return { toolPermissions: [], askUserQuestions: [] };
      }
      if (method === "runtime.run") throw new Error("pinned agentred offline");
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "继续" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(/Conversation history is still available/),
    ).toBeTruthy();
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/draft is kept/)).toBeNull();
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

// 任务 5 重构边界：SessionDetailView 是路由页（form="page"）与桌面 Chat 右栏
// （form="embedded"）共同消费的同一份真实会话详情视图。embedded 形态不包 AppShell、
// 无面包屑、无关注入口，但 relay attach/catchup/origin、转录、审批、Composer 全部保留。
describe("SessionDetailView 可复用视图(任务 5 重构边界)", () => {
  function renderEmbedded() {
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
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} sessionId={42} form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("embedded 形态:渲染真实详情,不包 AppShell,无面包屑/关注", async () => {
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
        event: { kind: "text_delta", text: "嵌入式转录" },
        seq: 1,
      });
    });

    renderEmbedded();

    // 真实转录渲染(attach + 补齐照常)。
    expect(await screen.findByText("嵌入式转录")).toBeTruthy();
    // 无 AppShell(无 SideNav / 无面包屑导航)。
    expect(screen.queryByRole("navigation")).toBeNull();
    // 桌面嵌入:无关注按钮(关注入口在列表行 R12 / 页面顶栏决策 16)。
    expect(screen.queryByRole("button", { name: /Follow/i })).toBeNull();
    // relay attach/catchup 照常走。
    expect(fakeClient.attach).toHaveBeenCalledWith(42, undefined);
    expect(fakeClient.catchUp).toHaveBeenCalledWith(42, undefined);
    // 发送能力仍在(桌面右栏同样要能回复)。
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  // 桌面 Chat 右栏点行 A 再点行 B:同实例换 props,无 key 强制重挂。会话级状态
  // (summary / events / originRef / ready)必须按 deviceId/sessionId 重置并重新
  // attach + 补齐,否则右栏残留上一条会话的标题/转录,发消息也落在 A 的 origin 上。
  it("切换选中会话(同实例新 props):重置转录并重新 attach,不残留上一条会话", async () => {
    const summaryB = { ...summary, sessionId: 43, title: "重构列表页" };
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
        event: { kind: "text_delta", text: "A 的转录" },
        seq: 1,
      });
    });

    const { rerender } = renderEmbedded();
    expect(await screen.findByText("A 的转录")).toBeTruthy();

    // 切到同机器上的另一条会话(43):request 返回 43 的摘要,catchUp 推 43 的转录。
    fakeClient.request.mockImplementation(async (method) => {
      if (method === "runtime.session.list")
        return { sessions: [summaryB], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        sessionId: 43,
        event: { kind: "text_delta", text: "B 的转录" },
        seq: 1,
      });
    });
    // 保持与首次渲染相同的包装结构(Router/ThemeProvider 不换),只换 props。
    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} sessionId={43} form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    // 必须重新 attach 43 并补齐,展示 B 的转录;A 的转录不再残留。
    expect(await screen.findByText("B 的转录")).toBeTruthy();
    expect(screen.queryByText("A 的转录")).toBeNull();
    await vi.waitFor(() => {
      expect(fakeClient.attach).toHaveBeenCalledWith(43, undefined);
    });
  });

  // R11：reconnecting 时探测一次连接失败原因。旧设备那一次探测还在路上就切到新
  // 目标时,它的结论不得在切换之后落地——否则右栏会挂起旧机器的「离线」横幅（甚至
  // 把浏览器误判成已解除授权）直到整页刷新。与文件里其它异步 effect 一样,探测也
  // 必须带 alive 守卫,切换目标 / 卸载后丢弃在途应答。
  it("reconnecting 期间切换目标设备:不残留旧设备的探测结论", async () => {
    const webDev = {
      id: 9,
      name: "浏览器",
      kind: "web",
      fingerprint: "fp-web",
      last_seen_at: 0,
      status: 1,
      online: true,
    };
    const dev1 = { ...deviceRow, id: 1, name: "机器A", online: false };
    const dev2 = { ...deviceRow, id: 2, name: "机器B", online: true };

    // 旧设备(1)的探测先发出、后落定:挂起,稍后手动 resolve。
    let resolveProbe1!: (v: unknown) => void;
    const probe1 = new Promise((r) => {
      resolveProbe1 = r;
    });

    let call = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path !== "/v1/devices") throw new Error("unexpected: " + path);
      call += 1;
      // call1=设备1取设备, call2=设备1的探测(挂起),
      // call3=设备2取设备, call4=设备2的探测。
      if (call === 2) return probe1;
      return { devices: call <= 2 ? [webDev, dev1] : [webDev, dev2] };
    });

    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState: "reconnecting",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    }));

    const { rerender } = render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} sessionId={42} form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    // 让取设备/探测的在途应答先落定(不在 waitFor 轮询里裸 setState)。
    await act(async () => {});

    // 切到另一台机器(2):重新取设备 + 重新允许探测。
    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={2} sessionId={43} form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await act(async () => {});

    // 设备2在线 + 中继 reconnecting → 状态横幅是 reconnecting,不是 machineOffline。
    await vi.waitFor(() => {
      const view = screen.getByTestId("session-detail-view");
      expect(
        view.querySelector('[data-session-status="reconnecting"]'),
      ).toBeTruthy();
    });

    // 旧设备(1)的探测现在才回来(离线):不得覆盖新目标的在线判定。
    await act(async () => {
      resolveProbe1({ devices: [webDev, dev1] });
    });

    await vi.waitFor(() => {
      const view = screen.getByTestId("session-detail-view");
      expect(
        view.querySelector('[data-session-status="machineOffline"]'),
      ).toBeNull();
    });
  });

  it("页面形态:详情头部渲染状态标记与机器 meta(标题仍由 AppShell TopBar 呈现)", async () => {
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

    renderPage();
    await screen.findByText(/重构登录页/);
    // 状态标记:summary.lifecycleState=idle → 显示 Idle,不止靠颜色。
    const pill = await screen.findByTestId("session-detail-status");
    expect(pill.textContent).toContain("Idle");
    // 机器 meta:设备名出现在详情头部。
    expect(
      (await screen.findByTestId("session-detail-meta")).textContent,
    ).toContain("书房小主机");
  });
});

// 设备取数失败后的恢复路径：/v1/devices 一次网络抖动失败就把 deviceError 置上，
// 之后即使切换目标设备、重新取数成功，错误也必须被清掉 —— 否则桌面 Chat 右栏的
// 嵌入详情从这次失败起永久卡在错误态，点任何一行都只显示旧错误（只有整页刷新能救）。
describe("SessionDetailView:设备取数失败后的恢复", () => {
  it("切换目标设备重新取到设备时清掉旧错误，不永久卡在错误态", async () => {
    const dev2 = { ...deviceRow, id: 2, name: "机器B" };
    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState: "connected",
      webDevice: { fingerprint: "fp-web", accessToken: "t", deviceId: 9 },
      webDeviceError: null,
    }));
    fakeClient.request.mockImplementation(async (method: string) => {
      if (method === "runtime.session.list")
        return { sessions: [summary], supportsSessionMetadata: true };
      if (method === "runtime.session.pendingWaiters")
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    // 第一次取设备失败 → 就地报错（必须在 render 前设好：RTL 的 render 已在 act 里
    // 跑完首轮 effect）。
    mockedApi.mockRejectedValue(new Error("network down"));
    const { rerender } = render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} sessionId={42} form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(
      screen.getByText("Could not load your devices. Please try again."),
    ).toBeTruthy();

    // 切到另一台机器：重新取设备成功 → 旧错误必须清掉，渲染真实详情。
    mockedApi.mockResolvedValue({ devices: [dev2] } as never);
    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={2} sessionId={43} form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    await vi.waitFor(() => {
      expect(
        screen.queryByText("Could not load your devices. Please try again."),
      ).toBeNull();
    });
  });
});
