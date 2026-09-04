/**
 * 会话详情页（R6 / R8 / R9 / R10 的页面接线）：
 *   - attach + 按 seq 游标补齐 → 转录渲染。
 *   - 发新消息 → runtime.run（R9，带 sourceDevice / sourceDeviceName）。
 *   - 批准工具调用 → runtime.submitToolPermission（R10）。
 *   - 待决策已被别的端回答 → 就地说明「已被处理」并刷新状态（R10）。
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  rpcMethods,
  SessionLifecycleRunning,
  type AnyRpcMethod,
} from "@agentre-hub/agentre-wire";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { RelayError, type RelayState } from "@/lib/relayClient";
import {
  useRelayMachine,
  type UseRelayMachineOptions,
} from "@/hooks/use-relay";
import { toast } from "sonner";

import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import SessionDetailView, {
  RELAY_TAIL_FRAMES,
} from "@/components/session/SessionDetailView";
import SessionDetail from "@/pages/SessionDetail";
import { writeReasoningEffortToOrigin } from "@/components/session/sessionMirror";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

// 发起端那一台由 sessionMirror 向连接池另借一条通道写（承载端就是页面手上这条）。
// 只桩这一个导出：这个文件的其余部分照旧走真实实现。
vi.mock("@/components/session/sessionMirror", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/session/sessionMirror")>();
  return { ...actual, writeReasoningEffortToOrigin: vi.fn(async () => {}) };
});

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);
const mockWriteEffortToOrigin = vi.mocked(writeReasoningEffortToOrigin);

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
  conversationId: "42",
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
  // 镜像历史应用完之后由页面预置游标，实时流据此接上（不重拉 server 已有的那段）。
  setCursor: vi.fn(),
  getCursor: vi.fn(() => 0),
  close: vi.fn(),
};

/**
 * 输入框现在是共享包的 `AIChatInput`（TipTap），不再是 `<textarea>`：`fireEvent.change`
 * 与 `.value` 都对它不成立 —— ProseMirror 的输入处理要真浏览器，jsdom 下 DOM 事件
 * 驱动不动它（实测：input / paste 都不改变文档）。
 *
 * 但 TipTap 把 Editor 实例挂在它自己的 contenteditable 元素上
 * （`editor.view.dom.editor`），测试从那里拿就够了 —— 不必为了测试在生产代码上
 * 开一个 `editorRef` 之类的口子。
 */
function composerEditable(): HTMLElement & {
  editor?: { commands: { setContent: (v: string) => void } };
} {
  const el = document.querySelector<HTMLElement>(
    '[data-testid="session-detail-composer"] .ProseMirror',
  );
  if (!el) throw new Error("输入框没渲染出来");
  return el;
}

/** 等输入框那一 chunk 加载完（它是 React.lazy 切出去的）。 */
async function awaitComposer() {
  await vi.waitFor(() => composerEditable());
}

async function typeInComposer(text: string) {
  await awaitComposer();
  composerEditable().editor?.commands.setContent(`<p>${text}</p>`);
}

/** 打字并回车发出去。 */
async function sendInComposer(text: string) {
  await typeInComposer(text);
  fireEvent.keyDown(composerEditable(), { key: "Enter" });
}

/** 输入框当前的文本。 */
function composerText(): string {
  return composerEditable().textContent ?? "";
}

/** 输入框是否停用。TipTap 走 `setEditable(false)`，落成 contenteditable="false"。 */
function composerDisabled(): boolean {
  return composerEditable().getAttribute("contenteditable") !== "true";
}

/** `/chat` 的桩：只把「到了这一页、地址上带了什么」说出来。 */
function ChatStub() {
  const location = useLocation();
  return (
    <p data-testid="chat-page" data-testid-search={location.search}>
      <span data-testid="chat-search">{location.search}</span>
    </p>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  capturedOpts = {};
  mockWriteEffortToOrigin.mockReset();
  mockWriteEffortToOrigin.mockResolvedValue(undefined);
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockClear();
  fakeClient.setCursor.mockReset();
  fakeClient.getCursor.mockReset();
  fakeClient.getCursor.mockReturnValue(0);
  fakeClient.attach.mockImplementation(async () => ({}));
  fakeClient.catchUp.mockImplementation(async () => {});
});

function renderPage() {
  mockUseRelay.mockImplementation((_fp, opts) => {
    capturedOpts = opts ?? {};
    return {
      client: fakeClient as never,
      relayState: "connected",
      relayTicket: {
        clientId: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      reconnect: vi.fn(),
    };
  });
  return render(
    <MemoryRouter initialEntries={["/devices/1/sessions/42"]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/devices/:deviceId/sessions/:conversationId"
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "你好" },
        seq: 1,
      });
    });

    renderPage();

    expect(
      await screen.findByText("你好", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    // 自己发起的会话没有 origin：省略即「调用方自己的对端」。
    expect(fakeClient.attach).toHaveBeenCalledWith("42", undefined);
    expect(fakeClient.catchUp).toHaveBeenCalledWith("42", undefined);
  });

  // agentred 每次重启都会把非终态会话标成 interrupted（daemon.New 的
  // 「marked N non-terminal sessions interrupted after restart」），而 daemon 的
  // Attach 对 interrupted 一律回 ErrNoActiveTurn ——「那一轮的子进程随上一个 daemon
  // 进程消亡了」，接回实时流没有意义。但它同一处注释也写明：**历史仍可 Pull**。
  //
  // 此前本页把 attach 与补齐放在同一个 try 里、attach 在前，于是这条「接不回实时流」
  // 被整体当成「这条对话读不到」：补齐一次都不发，页面停在
  // 「没能从这台机器读到这条对话的内容」——而机器在线、历史也确实在那里。存量一旦
  // 全沉淀成 interrupted（开发机重启若干次之后就是），每一条对话都打不开。
  //
  // 正确形状在同仓库里已有一份：mirror_svc.catchUp —— interrupted 直接跳过 attach，
  // 高水位退回清单快照那一份，补齐照常。
  it("interrupted 会话:跳过 attach,历史照样补齐渲染,不报读不到", async () => {
    const interrupted = { ...summary, lifecycleState: "interrupted" };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [interrupted] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    // 真 daemon 对 interrupted 会话的回答。桩成拒绝，才能证明本页没有去问它。
    fakeClient.attach.mockRejectedValue(
      new RelayError(-32002, "no active turn"),
    );
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "你好" },
        seq: 1,
      });
    });

    renderPage();

    expect(
      await screen.findByText("你好", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(fakeClient.attach).not.toHaveBeenCalled();
    expect(fakeClient.catchUp).toHaveBeenCalledWith("42", undefined);
    expect(screen.queryByTestId("session-catchup-failed")).toBeNull();
  });

  // 清单说 idle、接入那一刻已经被中断（两次往返之间会话状态会变），或这条会话已经
  // 不在这台机器上：attach 失败仍然只是「接不回实时流」这一件事，历史照拉。
  // mirror_svc 在 attach 成功与否两条路上都继续 pull，本页也必须如此。
  it("attach 被拒:仍然补齐历史并渲染,不报读不到", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.attach.mockRejectedValue(
      new RelayError(-32002, "no active turn"),
    );
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "你好" },
        seq: 1,
      });
    });

    renderPage();

    expect(
      await screen.findByText("你好", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(fakeClient.catchUp).toHaveBeenCalledWith("42", undefined);
    expect(screen.queryByTestId("session-catchup-failed")).toBeNull();
  });

  // 补齐本身失败才是「读不到」：那一句必须留着，它守的是 R6 的另一半
  // （此前是空 catch，页面停在一条空转录上不出声）。
  it("补齐失败:如实报读不到", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockRejectedValue(new RelayError(-32012, "pull failed"));

    renderPage();

    expect(
      await screen.findByTestId("session-catchup-failed", undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();
  });

  // 真实的 session.list 每一次都解出**新的**摘要对象（Protobuf → domain 的转换按调用
  // 生成，见 agentre-wire 的 sessionListFromProtobuf）。装载 effect 的依赖里因此不能
  // 出现「每次渲染都换身份」的东西：那样 setSummary 引起的重渲染会把 effect 整只重挂，
  // 上一轮的 alive() 随之为假，`setReady(true)` 一次都执行不到 —— attach / 补齐在中继上
  // 无限重跑，转录永远停在「正在从这台机器读取这条对话…」。
  //
  // 这一条用「每次给新对象」的清单桩把那个条件复现出来：断言装载只跑一次、并且转录
  // 真的渲染出来。
  it("清单每次返回新对象:装载只跑一次,转录照常渲染", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    // attach / 补齐是真的往返一次中继，不是立刻兑现的 promise。这一点必须照实模拟：
    // React 的重渲染排在宏任务上，而立刻兑现的 promise 在微任务上恢复——桩若不落一格
    // 宏任务，整只 effect 会在页面重渲染之前跑完，空转就复现不出来。
    const tick = () => new Promise((r) => setTimeout(r, 0));
    fakeClient.request.mockImplementation(async (method) => {
      await tick();
      // 关键：每次调用都是一份新对象，与真实转换同构。
      if (method === rpcMethods.sessionList)
        return { sessions: [{ ...summary }] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.attach.mockImplementation(async () => {
      await tick();
      return {};
    });
    fakeClient.catchUp.mockImplementation(async () => {
      await tick();
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "你好" },
        seq: 1,
      });
    });

    renderPage();

    expect(
      await screen.findByText("你好", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    // 静置一段再数：空转是持续的，只看一眼数不出来。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(fakeClient.attach).toHaveBeenCalledTimes(1);
    expect(fakeClient.catchUp).toHaveBeenCalledTimes(1);
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
      if (method === rpcMethods.sessionList) return { sessions: [remote] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    // 读路径：attach 与游标补齐都指向发起端那条会话。
    await vi.waitFor(() => {
      expect(fakeClient.attach).toHaveBeenCalledWith("42", "fp-desktop");
      expect(fakeClient.catchUp).toHaveBeenCalledWith("42", "fp-desktop");
    });
    // 待决策快照同样按 origin 问（否则问到的是空会话，审批卡永远不出现）。
    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === rpcMethods.sessionPendingWaiters,
      );
      expect(call?.[1]).toMatchObject({ peerFingerprint: "fp-desktop" });
    });

    // 写路径：这一轮必须落在发起端那条会话上。
    await sendInComposer("把按钮改成蓝色");
    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === rpcMethods.runtimeRun,
      );
      expect(call?.[1]).toMatchObject({
        conversationId: "42",
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    await sendInComposer("把按钮改成蓝色");

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === rpcMethods.runtimeRun,
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({
        conversationId: "42",
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

  it("发送在途：提交键转成 spinner，输入框不再整块禁用", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      // 一直在飞：这条用例量的就是「按下之后到回声落地之前」那段窗口。
      if (method === rpcMethods.runtimeRun) return new Promise(() => {});
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer("把按钮改成蓝色");

    // 这段窗口里用户那句话在转录里还不存在（要等 daemon 的 user_message 回声过一个
    // 往返），三点也要等 runtime.run 应答才点亮。此前 sending 被折进 disabled：
    // 输入框被清空并整块禁用，屏幕上一个字都没有他刚说的话。
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Sending…")).toBeTruthy(),
    );
    expect(composerDisabled()).toBe(false);
  });

  it("选择图片后发送会把图片编码为 runtime.run userBlocks", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await awaitComposer();
    fireEvent.change(
      screen.getByLabelText("Add image", { selector: "input" }),
      {
        target: {
          files: [
            new File([new Uint8Array([1, 2, 3])], "shot.png", {
              type: "image/png",
            }),
          ],
        },
      },
    );
    await screen.findByAltText("shot.png");
    fireEvent.click(screen.getByTestId("session-detail-send"));

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (entry) => entry[0] === rpcMethods.runtimeRun,
      );
      expect(call?.[1]).toMatchObject({
        userText: "",
        userBlocks: [
          {
            type: "image",
            data: new TextEncoder().encode(
              JSON.stringify({
                media_type: "image/png",
                source: { inline: "AQID" },
              }),
            ),
          },
        ],
      });
    });
  });

  it("选择权限与供应商模型后 runtime.run 使用所选执行参数", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents")
        return {
          agents: [
            {
              sync_id: "ag-1",
              name: "Claude",
              exec_targets: [{ backend_sync_id: "backend-1", current: true }],
            },
          ],
        };
      if (path === "/v1/engine/backends")
        return {
          backends: [
            {
              sync_id: "backend-1",
              provider_key: "anthropic",
              model_key: "sonnet",
              default_permission_mode: "default",
            },
          ],
        };
      if (path === "/v1/engine/providers")
        return {
          providers: [
            {
              provider_key: "anthropic",
              name: "Anthropic",
              type: "anthropic",
              default_model_key: "sonnet",
              enabled: true,
              models: [
                {
                  model_key: "sonnet",
                  model_id: "claude-sonnet-4-6",
                  name: "Sonnet",
                  enabled: true,
                },
                {
                  model_key: "opus",
                  model_id: "claude-opus-4-6",
                  name: "Opus",
                  enabled: true,
                },
              ],
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [summary],
          // 这台机器认识会话级模型目标。**显式声明**，不从那两格是否为空推断。
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      // 档位集合来自执行端自己报的能力矩阵，不再由本站按 backendType 猜。
      // 形状是 Protobuf 的 RuntimeCapabilitiesResponse：档位在 permission_mode 那一格。
      if (method === rpcMethods.runtimeCapabilities)
        return {
          capabilities: [],
          permissionMode: {
            allowedModes: [
              "default",
              "acceptEdits",
              "plan",
              "bypassPermissions",
            ],
            defaultMode: "default",
            switchableDuringTurn: true,
            order: ["default", "acceptEdits", "plan", "bypassPermissions"],
          },
        };
      if (method === rpcMethods.runtimeSetPermissionMode) return {};
      if (method === rpcMethods.setModelTarget) return {};
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    const permissionPill = await screen.findByRole("button", {
      name: /Permission mode/,
    });
    fireEvent.click(permissionPill);
    fireEvent.click(screen.getByRole("option", { name: /Accept Edits/ }));
    fireEvent.click(screen.getByRole("button", { name: /Provider and model/ }));
    fireEvent.click(screen.getByRole("option", { name: /Opus/ }));
    await sendInComposer("继续");

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (entry) => entry[0] === rpcMethods.runtimeRun,
      );
      expect(call?.[1]).toMatchObject({
        permissionMode: "acceptEdits",
        llmProviderKey: "anthropic",
        llmModelKey: "opus",
      });
    });
  });

  // ── 权限档位来自执行端，不由本站按后端类型猜 ─────────────────────────────
  //
  // 此前四档连同文案写死在详情页的调用点上，且只对 claudecode 给：codex 实际有
  // 两档，本站既列不出它支持的，也会对别的后端列出它不支持的。

  function mockCapabilities(answer: unknown) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeCapabilities) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
      throw new Error("unexpected: " + method);
    });
  }

  it("只报两档的后端就只列两档", async () => {
    mockCapabilities({
      capabilities: [],
      permissionMode: {
        allowedModes: ["default", "plan"],
        defaultMode: "default",
        order: ["default", "plan"],
      },
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Permission mode/ }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  /**
   * 账号侧那一档是**当前执行目标**上的预设，而这条对话跑在它当初派发到的那一档
   * 上——两者的后端种类可以不同（claudecode 四档 / codex 两档）。所以拿它当起手值
   * 之前必须先问「这台机器认不认」：不认就退回执行端报的默认档。
   *
   * 不校验的话，一条 codex 对话会在头上顶一颗红色的 Bypass（codex 根本没有这一
   * 档），而且这一档**每一轮都随 runtime.run 过线**（useSessionSend），执行端
   * ApplyRequested 会拿 ChatPermissionModeInvalid 把这一轮直接顶回来。
   */
  it("账号侧那一档不在这台机器的集合里时，退回执行端的默认档", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents")
        return {
          agents: [
            {
              sync_id: "ag-1",
              name: "Claude",
              exec_targets: [{ backend_sync_id: "backend-1", current: true }],
            },
          ],
        };
      if (path === "/v1/engine/backends")
        return {
          backends: [
            {
              sync_id: "backend-1",
              provider_key: "anthropic",
              model_key: "sonnet",
              // 当前执行目标是 claudecode，管理员在它上面配了 bypass。
              default_permission_mode: "bypassPermissions",
            },
          ],
        };
      if (path === "/v1/engine/providers") return { providers: [] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      // 这条对话本人跑在 codex 上：两档，没有 bypass。
      if (method === rpcMethods.runtimeCapabilities)
        return {
          capabilities: [],
          permissionMode: {
            allowedModes: ["default", "plan"],
            defaultMode: "default",
            order: ["default", "plan"],
            switchableDuringTurn: false,
          },
        };
      throw new Error("unexpected: " + method);
    });

    renderPage();
    // 输入框那一 chunk 是 lazy 的，pill 在它里面：先等它到位，再看脸上写的是哪一档。
    await awaitComposer();
    const pill = await screen.findByRole("button", { name: /Permission mode/ });
    await vi.waitFor(() => expect(pill.textContent).toContain("Default"));
    expect(pill.textContent).not.toContain("Bypass");
  });

  it("这台机器答不出档位时直接说明问不到，不显示 unknown 档位", async () => {
    mockCapabilities(new Error("machine says no"));

    renderPage();
    expect(
      screen.queryByRole("button", { name: /Permission mode/ }),
    ).toBeNull();
    expect(
      await screen.findByText(
        "This machine cannot list permission modes right now",
      ),
    ).toBeTruthy();
  });

  // 与上一条是**两件不同的事**，但只有上一条值得说：这一条是稳定答案（builtin
  // 没有权限门），底栏空着本身就是完整的答案 —— 桌面端也是这么办的，没有档可切
  // 就不摆那颗 pill。写一句「这个后端没有权限档位」是在给用户一件他既做不了、
  // 也不必知道的事。上一条不同：那是本该有档却问不出来，属于异常，仍要说。
  it("这个后端本来就没有权限档位时，控件整颗不摆", async () => {
    mockCapabilities({
      capabilities: [],
      permissionMode: { allowedModes: [] },
    });

    renderPage();
    await screen.findByTestId("session-detail-composer");
    await vi.waitFor(() =>
      expect(fakeClient.request).toHaveBeenCalledWith(
        rpcMethods.runtimeCapabilities,
        expect.anything(),
      ),
    );
    // 应答已消费：底栏要说的话此刻早该在了。
    await act(async () => {});

    expect(
      screen.queryByRole("button", { name: /Permission mode/ }),
    ).toBeNull();
    expect(
      screen.queryByText("This backend has no permission modes"),
    ).toBeNull();
  });

  // ── 模型目标：三态、持久化、两台机器 ─────────────────────────────────────

  function mockModelTarget(opts: {
    sessionProviderKey?: string;
    sessionModelKey?: string;
    setModelTarget?: () => unknown;
  }) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents")
        return {
          agents: [
            {
              sync_id: "ag-1",
              name: "Claude",
              exec_targets: [{ backend_sync_id: "backend-1", current: true }],
            },
          ],
        };
      if (path === "/v1/engine/backends")
        return {
          backends: [
            {
              sync_id: "backend-1",
              provider_key: "anthropic",
              model_key: "sonnet",
              default_permission_mode: "default",
            },
          ],
        };
      if (path === "/v1/engine/providers")
        return {
          providers: [
            {
              provider_key: "anthropic",
              name: "Anthropic",
              type: "anthropic",
              default_model_key: "sonnet",
              enabled: true,
              models: [
                {
                  model_key: "sonnet",
                  model_id: "claude-sonnet-4-6",
                  name: "Sonnet",
                  enabled: true,
                },
                {
                  model_key: "opus",
                  model_id: "claude-opus-4-6",
                  name: "Opus",
                  enabled: true,
                },
              ],
            },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [
            {
              ...summary,
              providerKey: opts.sessionProviderKey ?? "",
              modelKey: opts.sessionModelKey ?? "",
            },
          ],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeCapabilities)
        return { capabilities: [], permissionMode: { allowedModes: [] } };
      if (method === rpcMethods.setModelTarget)
        return opts.setModelTarget ? opts.setModelTarget() : {};
      throw new Error("unexpected: " + method);
    });
  }

  // 会话没钉目标 = 跟随 Agent 绑定，而且这句话要**写在脸上**。此前这里静默回落到
  // 后端绑定值，界面上与「用户显式选了那个模型」一模一样。
  //
  // 脸上跟的是模型**标识符**而不是人读名：推导归共享包之后两端同一份，而包里
  // 触发器的注释写明「解析出模型就写模型 ID（标识符走等宽）」——人读名与标识符
  // 混排正是那句话在避免的事。
  it("没钉目标时脸上写「跟随 Agent 绑定」，并跟上解析到的模型", async () => {
    mockModelTarget({});

    renderPage();
    // 解析到什么要等引擎目录落地：绑定那一档的模型是从目录里查出来的。
    await vi.waitFor(() => {
      const pill = screen.getByRole("button", { name: /Provider and model/ });
      expect(pill.textContent).toContain("Follow agent binding");
      expect(pill.textContent).toContain("claude-sonnet-4-6");
    });
  });

  it("钉了固定模型时脸上就写那个模型", async () => {
    mockModelTarget({
      sessionProviderKey: "anthropic",
      sessionModelKey: "opus",
    });

    renderPage();
    await vi.waitFor(() => {
      const pill = screen.getByRole("button", { name: /Provider and model/ });
      expect(pill.textContent).toContain("claude-opus-4-6");
      expect(pill.textContent).not.toContain("Follow agent binding");
    });
  });

  it("选中之后写到执行端", async () => {
    mockModelTarget({});

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Provider and model/ }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Opus/ }));

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (entry) => entry[0] === rpcMethods.setModelTarget,
      );
      expect(call?.[1]).toMatchObject({
        conversationId: "42",
        providerKey: "anthropic",
        modelKey: "opus",
      });
    });
  });

  // 写不进去就回滚，不做「看起来成功了」的乐观留存——用户会以为下一轮用的是新模型。
  it("写不进去时回滚控件并如实说明", async () => {
    mockModelTarget({
      setModelTarget: () => {
        throw new Error("machine says no");
      },
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /Provider and model/ }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Opus/ }));

    await screen.findByTestId("composer-model-note");
    expect(screen.getByTestId("composer-model-note").textContent).toContain(
      "Model was not changed",
    );
    expect(
      screen.getByRole("button", { name: /Provider and model/ }).textContent,
    ).toContain("Follow agent binding");
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters) {
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
        conversationId: "42",
        event: {
          kind: "tool_permission_request",
          requestId: "tp-1",
          toolName: "Bash",
          input: { cmd: "ls" },
        },
        seq: 6,
      });
    });

    // 判据换过一次,值得说明为什么。
    //
    // 此前这里钉的是 DecisionPanel 的 approve-tool-allow 按钮,注释写着「转录里的
    // decision 信息卡是只读的,不能当证据」。归约器改成产出包的 DTO（带 canonical）
    // 之后那个前提反了:转录里那张审批卡现在是**可交互**的,而且就在这条审批发生
    // 的位置上,比页面底部另开一个面板更近。同一条待决因此不再重复显示 ——
    // panelWaiters 把转录已经画出来的那些从面板里滤掉了。
    //
    // 仍然钉住的是这条用例真正要证的事:实时事件到达后页面**主动重拉了一次**
    // pendingWaiters（fake runtime 阻塞在审批上,run 不会结束,onRunResultDone
    // 那条刷新路径到不了）。
    expect(await screen.findByText("Allow Once")).toBeTruthy();
    expect(waitersCall).toBeGreaterThanOrEqual(2);
  });

  it("批准工具调用走 runtime.submitToolPermission", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return {
          toolPermissions: [
            { RequestID: "tp-1", ToolName: "Bash", Input: { cmd: "ls" } },
          ],
          askUserQuestions: [],
        };
      if (method === rpcMethods.runtimeSubmitToolPermission) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    // 面板里那张卡现在**就是**转录里那张（共享包的 ToolPermissionCard），
    // testid 由包给。钉 testid 而不是标题：标题是包的文案，改了不该让本站红。
    expect(await screen.findByTestId("tool-permission-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === rpcMethods.runtimeSubmitToolPermission,
      );
      expect(call).toBeTruthy();
      expect(call?.[1]).toMatchObject({
        conversationId: "42",
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters) {
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
    // 面板里那张卡现在**就是**转录里那张（共享包的 ToolPermissionCard），
    // testid 由包给。钉 testid 而不是标题：标题是包的文案，改了不该让本站红。
    expect(await screen.findByTestId("tool-permission-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));

    // 不报错、不静默:就地说明已被处理。
    expect(
      await screen.findByText("This request has already been handled."),
    ).toBeTruthy();
    // 没有把提交发出去(预检发现已不在)。
    expect(
      fakeClient.request.mock.calls.some(
        (c) => c[0] === rpcMethods.runtimeSubmitToolPermission,
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters) {
        waiterCalls += 1;
        if (waiterCalls === 1)
          return {
            toolPermissions: [{ RequestID: "tp-1", ToolName: "Bash" }],
            askUserQuestions: [],
          };
        // 预检这一次挂了。
        throw new Error("pendingWaiters unavailable");
      }
      if (method === rpcMethods.runtimeSubmitToolPermission) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    // 面板里那张卡现在**就是**转录里那张（共享包的 ToolPermissionCard），
    // testid 由包给。钉 testid 而不是标题：标题是包的文案，改了不该让本站红。
    expect(await screen.findByTestId("tool-permission-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));

    await vi.waitFor(() => {
      expect(
        fakeClient.request.mock.calls.some(
          (c) => c[0] === rpcMethods.runtimeSubmitToolPermission,
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return {
          toolPermissions: [{ RequestID: "tp-1", ToolName: "Bash" }],
          askUserQuestions: [],
        };
      if (method === rpcMethods.runtimeSubmitToolPermission)
        throw new Error("relay: 连接未就绪");
      throw new Error("unexpected: " + method);
    });

    // 决策提交失败是**对刚才那一次点击的回执**，属于时间不属于版面（决策 8）：
    // 走 toast，而不是在面板下面长出一行 11px 红字。
    const errored = vi.spyOn(toast, "error");
    renderPage();
    // 面板里那张卡现在**就是**转录里那张（共享包的 ToolPermissionCard），
    // testid 由包给。钉 testid 而不是标题：标题是包的文案，改了不该让本站红。
    expect(await screen.findByTestId("tool-permission-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));

    await vi.waitFor(() => expect(errored).toHaveBeenCalled());
    expect(errored.mock.calls[0][0]).toBe(
      i18n.t("session.decision.submitFailed"),
    );
    // 带一个「重试」：回执上没有出路的话，用户只能再点一次那个刚刚失败的按钮。
    const opts = errored.mock.calls[0][1] as {
      action?: { label?: string };
    };
    expect(opts?.action?.label).toBe(i18n.t("session.decision.retry"));
    // 版面上不再留那行红字。
    expect(screen.queryByText(/could not be submitted/i)).toBeNull();
    errored.mockRestore();
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters) {
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
      if (method === rpcMethods.runtimeSubmitToolPermission) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    // 面板里那张卡现在**就是**转录里那张（共享包的 ToolPermissionCard），
    // testid 由包给。钉 testid 而不是标题：标题是包的文案，改了不该让本站红。
    expect(await screen.findByTestId("tool-permission-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow Once" }));
    expect(
      await screen.findByText("This request has already been handled."),
    ).toBeTruthy();

    await act(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "tool_permission_request", requestId: "tp-2" },
        seq: 9,
      });
    });

    // tp-2 是**经事件流**来的，所以转录里就有它的可交互审批卡，panelWaiters 把它
    // 从面板里滤掉了（同一条待决不重复显示两处）。tp-1 只在 waiters 里出现过、
    // 事件流里没有，所以上面那一步仍然走的是面板 —— 这正是面板不能删的理由。
    expect(await screen.findByText("Allow Once")).toBeTruthy();
    await vi.waitFor(() => {
      expect(screen.queryByText("This request has already been handled.")).toBe(
        null,
      );
    });
  });
});

describe("会话详情页:发送失败", () => {
  it("桌面端在场但钉住的 agentred 不可用:历史仍可读、新写入停用并给专门说明", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") {
        return { devices: [{ ...deviceRow, kind: "desktop" }] };
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) {
        return { sessions: [summary] };
      }
      if (method === rpcMethods.sessionPendingWaiters) {
        return { toolPermissions: [], askUserQuestions: [] };
      }
      // daemon 对这一类的真实应答：inbound.go:205 的 -32015 + PeerSessionRunResult。
      // 「任何失败都算 agentred 不可用」是缺口二，判据换成了这个真码。
      if (method === rpcMethods.runtimeRun) throw executionUnavailableError();
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    await sendInComposer("继续");

    expect(await screen.findByText(/New messages cannot be sent/)).toBeTruthy();
    expect(composerDisabled()).toBe(true);
    expect(screen.queryByTestId("send-failure")).toBeNull();
  });

  it("发送失败:就地报错,不静默吞掉", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) throw new Error("boom");
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    await sendInComposer("把按钮改成蓝色");

    expect(await screen.findByTestId("send-failure")).toBeTruthy();
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
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
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
    expect(fakeClient.attach).toHaveBeenCalledWith("42", undefined);
    expect(fakeClient.catchUp).toHaveBeenCalledWith("42", undefined);
    // 发送能力仍在(桌面右栏同样要能回复)。
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  // 桌面 Chat 右栏点行 A 再点行 B:同实例换 props,无 key 强制重挂。会话级状态
  // (summary / events / originRef / ready)必须按 deviceId/conversationId 重置并重新
  // attach + 补齐,否则右栏残留上一条会话的标题/转录,发消息也落在 A 的 origin 上。
  it("切换选中会话(同实例新 props):重置转录并重新 attach,不残留上一条会话", async () => {
    const summaryB = { ...summary, conversationId: "43", title: "重构列表页" };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "A 的转录" },
        seq: 1,
      });
    });

    const { rerender } = renderEmbedded();
    expect(await screen.findByText("A 的转录")).toBeTruthy();

    // 切到同机器上的另一条会话(43):request 返回 43 的摘要,catchUp 推 43 的转录。
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summaryB] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "43",
        event: { kind: "text_delta", text: "B 的转录" },
        seq: 1,
      });
    });
    // 保持与首次渲染相同的包装结构(Router/ThemeProvider 不换),只换 props。
    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="43" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    // 必须重新 attach 43 并补齐,展示 B 的转录;A 的转录不再残留。
    expect(await screen.findByText("B 的转录")).toBeTruthy();
    expect(screen.queryByText("A 的转录")).toBeNull();
    await vi.waitFor(() => {
      expect(fakeClient.attach).toHaveBeenCalledWith("43", undefined);
    });
  });

  // R11：reconnecting 时探测一次连接失败原因。旧设备那一次探测还在路上就切到新
  // 目标时,它的结论不得在切换之后落地——否则右栏会挂起旧机器的「离线」横幅（甚至
  // 把浏览器误判成已解除授权）直到整页刷新。与文件里其它异步 effect 一样,探测也
  // 必须带 alive 守卫,切换目标 / 卸载后丢弃在途应答。
  it("reconnecting 期间切换目标设备:不残留旧设备的探测结论", async () => {
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
      return { devices: call <= 2 ? [dev1] : [dev2] };
    });

    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState: "reconnecting",
      relayTicket: {
        clientId: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      reconnect: vi.fn(),
    }));

    const { rerender } = render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    // 让取设备/探测的在途应答先落定(不在 waitFor 轮询里裸 setState)。
    await act(async () => {});

    // 切到另一台机器(2):重新取设备 + 重新允许探测。
    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={2} conversationId="43" form="embedded" />
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
      resolveProbe1({ devices: [dev1] });
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
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
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

// ── 插话（runtime.steer）与发送失败的三类诊断 ────────────────────────────────
//
// 桌面端的对端侧早就注册了 runtime.steer（agentre 仓 internal/peer/inbound.go:96,
// agentred 侧 daemon.go:1511 同样注册）。会话正在跑一轮时再发消息，桌面端走的是
// steer（把消息排进当前这一轮）；浏览器此前只会 runtime.run，一头撞上 chat_svc 的
// acquireTurnGate（chat.go:3419 → code.ChatSendInFlight）。
//
// 「会话正忙」在协议上**没有专属错误码**：它经 internal/daemon/rpc/conn.go:173
// 落成 -32603 + 本地化 message。所以正忙不靠解析错误判定，而是靠选路 + 一次回落
// 由 daemon 自己裁决；只有「执行目标不可用」有真码（inbound.go:205 的 -32015）。
const busyError = () =>
  new RelayError(-32603, "当前会话已有进行中的对话，请稍后再试", {
    code: -32603,
    message: "当前会话已有进行中的对话，请稍后再试",
  });
const noActiveTurnError = () =>
  new RelayError(-32603, "当前没有进行中的对话", {
    code: -32603,
    message: "当前没有进行中的对话",
  });
/** inbound.go:205 peerExecutionUnavailableCode + PeerSessionRunResult 载荷。 */
const executionUnavailableError = () =>
  new RelayError(
    -32015,
    "desktop history remains available, but the session execution target is unavailable",
    {
      code: -32015,
      message: "execution target unavailable",
      data: {
        accepted: false,
        historyAvailable: true,
        executionUnavailable: true,
      },
    },
  );

describe("会话详情页:正在跑一轮时发消息走 steer(插话)", () => {
  const runningSummary = { ...summary, lifecycleState: "running" };

  function mountWith(
    sess: typeof summary & { peerFingerprint?: string },
    onSend: (method: AnyRpcMethod) => unknown,
  ) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: AnyRpcMethod) => {
      if (method === rpcMethods.sessionList) return { sessions: [sess] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      return onSend(method);
    });
  }

  async function send(text: string) {
    // 发送期间输入框是停用的（TipTap 的 setEditable(false)），这一档下
    // triggerSubmit 会直接 return —— 连发两条时必须等它恢复可编辑再打第二条。
    await vi.waitFor(() => expect(composerDisabled()).toBe(false));
    await sendInComposer(text);
  }

  function callsOf(method: AnyRpcMethod) {
    return fakeClient.request.mock.calls.filter((c) => c[0] === method);
  }

  // Given 会话正在跑一轮 / When 浏览器发消息 / Then 走 runtime.steer 插进当前这一轮，
  // 而不是 runtime.run（run 会被 acquireTurnGate 直接拒掉）。
  it("Given 会话在跑 When 发消息 Then 走 runtime.steer 并带回 origin", async () => {
    mountWith({ ...runningSummary, peerFingerprint: "fp-desktop" }, (m) => {
      if (m === rpcMethods.runtimeSteer) return {};
      throw new Error("unexpected: " + m);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await send("顺便把标题也改了");

    await vi.waitFor(() => {
      expect(callsOf(rpcMethods.runtimeSteer)[0]?.[1]).toMatchObject({
        conversationId: "42",
        peerFingerprint: "fp-desktop",
        text: "顺便把标题也改了",
      });
    });
    expect(callsOf(rpcMethods.runtimeRun)).toHaveLength(0);
  });

  // Given 直连 agentred 的会话 / When 插话 / Then 带上 queuedId，否则这条消息拿不到
  // 「来自 <设备>」的归属标注。
  //
  // agentred 的 steer 处理器按 queuedId 记提交方（handlers/runtime.go:1100，门槛
  // 就是 `p.QueuedID != ""`），等 backend 消费掉这条 steer 时把 SourcePeer 盖回去。
  // 不传 = 那张表里没有条目 = 归属丢失。
  //
  // 注意这条**只对直连 agentred 的目标**成立：桌面端 peer 的 EnqueuePeerSession
  // 压根不看 params.QueuedID，它自己 newQueuedID() 再按 peerSource 记归属，所以
  // 桌面端目标不传也没事。这里仍然无条件带上——同一条发送路径不该按目标类型分叉。
  it("Given 会话在跑 When 插话 Then 带上 queuedId 供 agentred 归属来源", async () => {
    mountWith({ ...runningSummary, peerFingerprint: "fp-desktop" }, (m) => {
      if (m === rpcMethods.runtimeSteer) return {};
      throw new Error("unexpected: " + m);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await send("插一句");

    await vi.waitFor(() =>
      expect(callsOf(rpcMethods.runtimeSteer)).toHaveLength(1),
    );
    const params = callsOf(rpcMethods.runtimeSteer)[0]?.[1] as {
      queuedId?: string;
    };
    expect(params.queuedId).toBeTruthy();

    // 每条 steer 各自一个 id：agentred 那张表按 id 存提交方，撞 id 会让先来的
    // 那条被后来的覆盖掉。
    await send("再插一句");
    await vi.waitFor(() =>
      expect(callsOf(rpcMethods.runtimeSteer)).toHaveLength(2),
    );
    const second = callsOf(rpcMethods.runtimeSteer)[1]?.[1] as {
      queuedId?: string;
    };
    expect(second.queuedId).toBeTruthy();
    expect(second.queuedId).not.toBe(params.queuedId);
  });

  // Given 会话空闲 / When 发消息 / Then 仍走 runtime.run（开新一轮），不误发 steer。
  it("Given 会话空闲 When 发消息 Then 仍走 runtime.run", async () => {
    mountWith(summary, (m) => {
      if (m === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + m);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await send("开始重构");

    await vi.waitFor(() => {
      expect(callsOf(rpcMethods.runtimeRun)).toHaveLength(1);
    });
    expect(callsOf(rpcMethods.runtimeSteer)).toHaveLength(0);
  });

  // summary.lifecycleState 是**装载那一刻**的快照，此后永不刷新。所以选路不能只看它：
  // 自己刚发出去的一轮还在飞，第二条消息必须走 steer。
  it("Given 自己刚开了一轮 When 再发一条 Then 走 steer(不看陈旧的 lifecycle 快照)", async () => {
    mountWith(summary, (m) => {
      if (m === rpcMethods.runtimeRun) return {};
      if (m === rpcMethods.runtimeSteer) return {};
      throw new Error("unexpected: " + m);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await send("开始重构");
    await vi.waitFor(() =>
      expect(callsOf(rpcMethods.runtimeRun)).toHaveLength(1),
    );

    await send("顺便把标题也改了");
    await vi.waitFor(() =>
      expect(callsOf(rpcMethods.runtimeSteer)).toHaveLength(1),
    );
    expect(callsOf(rpcMethods.runtimeRun)).toHaveLength(1);
  });

  // 竞态 A：判定的瞬间轮次刚起。选路认为空闲 → run 被 daemon 拒（ChatSendInFlight），
  // 回落一次 steer 由 daemon 自己裁决，消息照样排进这一轮，不报错。
  it("Given 判定为空闲但轮次刚起 When run 被拒 Then 回落 steer 并排队成功", async () => {
    mountWith(summary, (m) => {
      if (m === rpcMethods.runtimeRun) throw busyError();
      if (m === rpcMethods.runtimeSteer) return {};
      throw new Error("unexpected: " + m);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await send("顺便把标题也改了");

    await vi.waitFor(() =>
      expect(callsOf(rpcMethods.runtimeSteer)).toHaveLength(1),
    );
    // 排进了当前这一轮：给出最小诚实反馈，草稿清空，不报失败。
    expect(
      await screen.findByText(/queued into the current turn/i),
    ).toBeTruthy();
    expect(composerText()).toBe("");
    expect(screen.queryByTestId("send-failure")).toBeNull();
  });

  // 竞态 B：判定的瞬间轮次刚结束。选路认为在跑 → steer 被拒（没有进行中的一轮），
  // 回落一次 run 开新一轮。
  it("Given 判定为在跑但轮次刚结束 When steer 被拒 Then 回落 run 开新一轮", async () => {
    mountWith(runningSummary, (m) => {
      if (m === rpcMethods.runtimeSteer) throw noActiveTurnError();
      if (m === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + m);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await send("继续");

    // 草稿清空是「这一条被接受了」的判据；等它落定，而不是只等请求发出去。
    await vi.waitFor(
      () => {
        expect(callsOf(rpcMethods.runtimeRun)).toHaveLength(1);
        expect(composerText()).toBe("");
      },
      { timeout: 3_000 },
    );
    expect(screen.queryByTestId("send-failure")).toBeNull();
    // 回落的是 run（开了新一轮），不是排队：不该出现「已排进这一轮」。
    expect(screen.queryByText(/queued into the current turn/i)).toBeNull();
  });
});

// 缺口二：sendMessage 的 catch 把**任何**失败都当成「这条会话钉住的 agentred
// 不可用」（只按 device.kind==="desktop" 分流），于是「会话正忙」被报成「守护进程
// 掉线」——一个假的故障。三类失败必须各自可区分。
describe("会话详情页:发送失败的三类诊断(缺口二)", () => {
  const desktopRow = { ...deviceRow, kind: "desktop" };

  function mount(onSend: (method: unknown) => unknown) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [desktopRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      return onSend(method);
    });
  }

  async function renderAndSend(text: string) {
    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer(text);
  }

  // Given 会话正忙且这个后端插不了话（run 与 steer 都被 daemon 拒）
  // When  用户发消息
  // Then  不得谎称「agentred 不可用」；如实说没发出去，并原样转述 daemon 自己的说明。
  it("Given 会话正忙 When run 与 steer 都被拒 Then 不谎报 agentred 不可用", async () => {
    mount((m) => {
      if (m === rpcMethods.runtimeRun) throw busyError();
      if (m === rpcMethods.runtimeSteer)
        throw new RelayError(-32603, "该后端不支持插话", {
          code: -32603,
          message: "该后端不支持插话",
        });
      throw new Error("unexpected: " + m);
    });

    await renderAndSend("顺便把标题也改了");

    // 对端收到了并明确拒绝 → rejected 那一类：重发是干净的，主按钮就是「重发」。
    const bubble = await screen.findByTestId("send-failure");
    expect(bubble.getAttribute("data-failure-kind")).toBe("rejected");
    // daemon 自己的本地化说明原样透出，不被替换成一个编造的故事。
    expect(
      within(bubble).getByText(/当前会话已有进行中的对话，请稍后再试/),
    ).toBeTruthy();
    expect(screen.queryByText(/New messages cannot be sent/)).toBe(null);
    // 历史可读、也没有被停用新写入。
    expect(composerDisabled()).toBe(false);
  });

  // Given daemon 回的是「执行目标不可用」的真码（-32015）
  // When  用户发消息
  // Then  这才是「钉住的 agentred 不可用」：历史可读、新写入停用、专门说明。
  it("Given daemon 回 -32015 When 发消息 Then 进入 agentred 不可用态", async () => {
    mount((m) => {
      if (m === rpcMethods.runtimeRun) throw executionUnavailableError();
      throw new Error("unexpected: " + m);
    });

    await renderAndSend("继续");

    expect(await screen.findByText(/New messages cannot be sent/)).toBeTruthy();
    expect(composerDisabled()).toBe(true);
    // 执行目标不可用不是竞态，不该再回落一次 steer。
    expect(
      fakeClient.request.mock.calls.some(
        (c) => c[0] === rpcMethods.runtimeSteer,
      ),
    ).toBe(false);
  });

  // Given 请求根本没走到 daemon（socket 刚断，RelayError code=-1）
  // When  用户发消息
  // Then  通用发送失败；不回落（可能已经送达，回落会重发），也不谎报 agentred 不可用。
  it("Given 传输层失败 When 发消息 Then 通用失败且不回落 steer", async () => {
    mount((m) => {
      if (m === rpcMethods.runtimeRun)
        throw new RelayError(-1, "relay: 连接已断开");
      throw new Error("unexpected: " + m);
    });

    await renderAndSend("继续");

    // 请求没走到对端 → transport 那一类，与 rejected 分开：它可能已经送达。
    const bubble = await screen.findByTestId("send-failure");
    expect(bubble.getAttribute("data-failure-kind")).toBe("transport");
    expect(screen.queryByText(/New messages cannot be sent/)).toBe(null);
    expect(
      fakeClient.request.mock.calls.some(
        (c) => c[0] === rpcMethods.runtimeSteer,
      ),
    ).toBe(false);
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
      relayTicket: {
        clientId: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      reconnect: vi.fn(),
    }));
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    // 第一次取设备失败 → 就地报错（必须在 render 前设好：RTL 的 render 已在 act 里
    // 跑完首轮 effect）。
    mockedApi.mockRejectedValue(new Error("network down"));
    const { rerender } = render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
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
          <SessionDetailView deviceId={2} conversationId="43" form="embedded" />
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

/**
 * 本轮（server 持有会话）：详情页的历史改从 server 镜像取，机器离线照样读得到整条
 * 转录——这正是这一轮的目的（规格「机器离线时只读」）。实时流按 seq 接在镜像历史
 * 后面：应用完历史先预置游标，中继才 attach + 补齐，浏览器因此不会把 server 已经
 * 有的那一段再从 daemon 拉一遍；跳号仍由中继客户端回执行端补洞。
 */
/**
 * 决策 11 的**入口分流**在详情页这一侧。
 *
 * 账号里有这条对话 → 按对话寻址：服务端查名单解析出承载它的机器，这一页全程不需要
 * 知道那是哪一台（跨机器的统一列表与深链接靠的就是它）。账号里没有（机器轴上那些
 * 还没保存的对话是大多数，服务端解析不出它们的承载机器）→ 按机器寻址，而那时机器
 * 正是用户刚点进来的这一台，本来就在上下文里。
 *
 * 分流一旦选错就是一条通道级错误，所以钉的是**开通道时声明的目标**本身。
 */
describe("会话详情：这条通道声明的目标", () => {
  function stubDevices() {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return { frames: [], cursor: 0, has_more: false };
      throw new Error("unexpected: " + path);
    });
  }

  /** 认领落定之前一条通道都不开：猜一次再改口等于白开一条会被判死的通道。 */
  function targets(): (string | null)[] {
    return mockUseRelay.mock.calls.map((c) => c[0]);
  }

  function mountDetail(
    initialRow?: Parameters<typeof SessionDetailView>[0]["initialRow"],
  ) {
    mockUseRelay.mockImplementation((_target, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "connecting",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId="42"
            form="embedded"
            initialRow={initialRow}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("账号里有这条对话：按对话寻址，不点名机器", async () => {
    stubDevices();
    mountDetail({
      conversation_id: "42",
      peer_fingerprint: "fp-desktop",
      machine_fingerprint: "fp-1",
      title: "重构登录页",
    });

    await vi.waitFor(() => expect(targets()).toContain("conversation:42"));
    expect(targets().some((t) => t?.startsWith("machine:"))).toBe(false);
  });

  it("账号里没有这条对话：退回按机器寻址（机器轴上那些还没保存的）", async () => {
    stubDevices();
    mountDetail();

    await vi.waitFor(() => expect(targets()).toContain("machine:fp-1"));
    expect(targets().some((t) => t?.startsWith("conversation:"))).toBe(false);
  });

  it("认领落定之前一条通道都不开", () => {
    stubDevices();
    mountDetail();

    // 首帧：账号那一行还没问回来，分流还没有答案。
    expect(targets()).toEqual([null]);
  });
});

/**
 * 切对话的那一瞬（同实例换 props，桌面右栏与索引页点下一行都是这条路）。
 *
 * `sid` 一变，重置块把 `history.settled` 拨回 false，`relayTarget` 因此短暂为
 * null；真 hook 在**没有目标**时的状态就是初值 "disconnected"（见 use-relay 的
 * `initialState`）。而 `machineOnline` 属于设备轴、不随 sid 重置 —— 切同一台机器
 * 上的另一条对话时它一直是 true。两件事凑在一起被 `deriveSessionViewStatus` 读作
 * 「连过又放弃了」，于是每切一次对话都先闪一条红色的「连接断了，已经不再自动
 * 重试」，横跨认领那一个往返。
 *
 * 「lost」的含义是「连过又放弃了」，那要求先有过一条通道。目标都还没定下来的
 * 那一段，正确的说法是「还在连」。
 */
describe("会话详情：切对话的那一瞬不闪「连接已断」", () => {
  /** 与真 hook 一致：没有目标 = 还没开始连，状态停在初值 "disconnected"。 */
  function stubRelayFollowingTarget() {
    mockUseRelay.mockImplementation((target, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: target ? (fakeClient as never) : null,
        relayState: target ? "connected" : "disconnected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
  }

  function row(id: string) {
    return {
      conversation_id: id,
      peer_fingerprint: "fp-1",
      machine_fingerprint: "fp-1",
      title: "对话 " + id,
    };
  }

  function ui(id: string) {
    return (
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId={id}
            form="embedded"
            initialRow={row(id)}
          />
        </ThemeProvider>
      </MemoryRouter>
    );
  }

  function lostBanner() {
    return screen.queryByText(i18n.t("session.banner.lost.title"));
  }

  it("切到同机器上的另一条对话：整段认领期间只说「连接中」,不报「已经不再自动重试」", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return { frames: [], cursor: 0, has_more: false };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    stubRelayFollowingTarget();

    const { rerender } = render(ui("42"));
    // 第一条连上了：机器在线（machineOnline=true）也已经问回来了。
    await vi.waitFor(() =>
      expect(mockUseRelay.mock.calls.map((c) => c[0])).toContain(
        "conversation:42",
      ),
    );
    expect(lostBanner()).toBeNull();

    // 切到 43：认领重来一遍，这一帧 relayTarget 又是 null。
    rerender(ui("43"));
    expect(lostBanner()).toBeNull();
    expect(
      document.querySelector('[data-session-status="connecting"]'),
    ).toBeTruthy();

    // 认领落定、通道重新开出来之后照常连上，不残留任何横幅。
    await vi.waitFor(() =>
      expect(mockUseRelay.mock.calls.map((c) => c[0])).toContain(
        "conversation:43",
      ),
    );
    expect(lostBanner()).toBeNull();
  });
});

/**
 * 切到**另一台机器**上的对话那一瞬。
 *
 * `useSessionTargetDevice` 的 device / machineOnline 是 `did` 变化时**重新去取**、
 * 而不是先清空：新设备那一个往返里，屏幕上挂着的仍是**上一台**的在线状态、名字
 * 与撤销状态。上一台离线时，新目标因此先被扣一顶「机器离线」的红帽子，横幅里还
 * 写着上一台的名字；反过来（上一台在线、新的其实离线）则更糟——那一段里输入框
 * 是可用的，敲进去的话发不出去。
 *
 * 与「切对话」那一处是同一类错：**还没问出来**被当成了一句肯定的答复。设备轴的
 * 正确初值是 null（「不知道」），`deriveSessionViewStatus` 早就为它留好了
 * 「连接中」那一档。
 */
describe("会话详情：切到另一台机器那一瞬不摆旧机器的状态", () => {
  const dev1 = { ...deviceRow, id: 1, name: "机器A", online: false };
  const dev2 = { ...deviceRow, id: 2, name: "机器B", online: true };

  function bannerStatus() {
    return document
      .querySelector("[data-session-status]")
      ?.getAttribute("data-session-status");
  }

  function ui(deviceId: number, conversationId: string) {
    return (
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={deviceId}
            conversationId={conversationId}
            form="embedded"
          />
        </ThemeProvider>
      </MemoryRouter>
    );
  }

  it("旧机器离线、新机器还没问回来：那一段说「连接中」,不报「机器离线」", async () => {
    // 设备 2 那一次取数挂起：这就是「还没问出来」的那一段。
    let resolveDev2!: (v: unknown) => void;
    const pendingDev2 = new Promise((r) => {
      resolveDev2 = r;
    });
    let deviceCalls = 0;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return { frames: [], cursor: 0, has_more: false };
      if (path !== "/v1/devices") throw new Error("unexpected: " + path);
      deviceCalls += 1;
      return deviceCalls === 1 ? { devices: [dev1] } : pendingDev2;
    });
    mockUseRelay.mockImplementation((target, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: target ? (fakeClient as never) : null,
        relayState: target ? "connected" : "disconnected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });

    const { rerender } = render(ui(1, "42"));
    // 机器 A 确实离线：这一档本身是对的。
    await vi.waitFor(() => expect(bannerStatus()).toBe("machineOffline"));

    // 切到机器 B 上的另一条对话：B 在不在线还没问回来。
    rerender(ui(2, "43"));
    expect(bannerStatus()).not.toBe("machineOffline");
    expect(screen.queryByText(/机器A/)).toBeNull();
    expect(bannerStatus()).toBe("connecting");

    // 问回来了（B 在线）：照常连上，不残留任何横幅。
    await act(async () => {
      resolveDev2({ devices: [dev2] });
    });
    await vi.waitFor(() => expect(bannerStatus()).toBeUndefined());
  });
});

describe("会话详情：历史来自 server 镜像", () => {
  /** 一页镜像转录：frames 是 wire.JournaledNotification 原样。 */
  function framePage(frames: { seq: number; text: string }[], hasMore = false) {
    return {
      frames: frames.map((f) => ({
        seq: f.seq,
        method: "runtime.event",
        params: {
          conversationId: "42",
          event: { kind: "text_delta", text: f.text },
        },
      })),
      cursor: frames.length > 0 ? frames[frames.length - 1].seq : 0,
      has_more: hasMore,
    };
  }

  /** 机器离线：没有中继客户端，连接态是 disconnected。 */
  function renderOfflinePage() {
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    return render(
      <MemoryRouter initialEntries={["/devices/1/sessions/42"]}>
        <ThemeProvider>
          <Routes>
            <Route
              path="/devices/:deviceId/sessions/:conversationId"
              element={<SessionDetail />}
            />
            {/* 「新建一个会话」的落点。真页面在这一组里跑不起来（它自己要取
                agents / projects），桩到这里就够了：本组要断的是**去了哪、带了
                什么**，那一屏怎么长在 new-conversation.test.tsx 里守。 */}
            <Route path="/chat" element={<ChatStub />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  const offlineDevice = { ...deviceRow, online: false };

  /**
   * 往上滚续读那一半在「转录只取尾巴」那一组里（它装了几何桩）：jsdom 不做布局，
   * scrollHeight / clientHeight 恒为 0，这里驱动不动滚动。本条守的是离线时**读得到**
   * 这件事本身，以及首屏的取数形状。
   */
  it("机器离线：转录照读，首屏是最后那一段，且按 conversation_id 取数", async () => {
    const asked: string[] = [];
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [offlineDevice] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript")) {
        asked.push(path);
        return {
          ...framePage([{ seq: 9, text: "离线也读得到的最后一句" }]),
          oldest_seq: 9,
          has_before: true,
        };
      }
      throw new Error("unexpected: " + path);
    });

    renderOfflinePage();

    // 机器不在线，但账号里那一段照样读得到 —— 首屏是**最后**那一段，不是从头翻。
    expect(await screen.findByText(/离线也读得到的最后一句/)).toBeTruthy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("conversation_id=42");
    // 发起端指纹不再参与寻址：端点的身份键就是 conversation_id（决策 1）。
    expect(asked[0]).not.toContain("peer_fingerprint");
    expect(asked[0]).toContain("direction=backward");
    expect(asked[0]).toContain("cursor=0");

    // 离线态如实说明（横幅按 R11 分类，不在这里重新推导）。
    expect(screen.getByRole("alert").getAttribute("data-session-status")).toBe(
      "machineOffline",
    );
  });

  /**
   * 左栏点一行进右栏时，那一整行本来就在宿主手里——它就是索引取回来的那一行，
   * 标题、Agent 身份、发起端指纹都在上面。
   *
   * 此前详情页仍会回头向服务端再要一遍（resolveMirrorRow 的
   * `/v1/agent-sessions?conversation_id=`）：一条纯属重复的请求，而且头部要等它往返
   * 回来才认得出这是哪条对话。宿主给得出整行时就不该再问。
   *
   * 从 URL 直接进来（移动端下钻、分享链接）没有这一行，那条认领路径照旧——本条
   * 守的是「给得出的时候不问」，不是把认领删掉。
   */
  it("宿主把索引行整行传下来时不再回头认领，头部与转录照常", async () => {
    const asked: string[] = [];
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [offlineDevice] };
      if (path.startsWith("/v1/agent-sessions?")) {
        asked.push(path);
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      }
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return {
          ...framePage([{ seq: 9, text: "离线也读得到的最后一句" }]),
          oldest_seq: 9,
          has_before: false,
        };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });

    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId="42"
            form="embedded"
            initialRow={{
              conversation_id: "42",
              peer_fingerprint: "fp-1",
              machine_fingerprint: "fp-1",
              title: "重构登录页",
              backend_type: "claudecode",
            }}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/离线也读得到的最后一句/)).toBeTruthy();
    // 认领那条一次都没发：这一行的内容宿主已经给过了。
    expect(asked).toEqual([]);
    // 而头部照样认得出这是哪条对话——替补摘要由传下来的那一行派生。
    expect(screen.getByTestId("session-detail-header").textContent).toContain(
      "重构登录页",
    );
  });

  it("机器离线：发送入口不可用，说明在等哪台机器且不排队（决策 13）", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [offlineDevice] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return framePage([{ seq: 1, text: "离线转录" }]);
      throw new Error("unexpected: " + path);
    });

    renderOfflinePage();
    await screen.findByText(/离线转录/);

    // 发不出去这件事现在由**只读条**表达，而不是一个永远灰着的输入框：
    // 后者是在暗示「也许待会儿能用」（决策 5）。
    expect(screen.queryByTestId("session-detail-send")).toBeNull();
    const readonly = screen.getByTestId("session-compose-readonly");
    expect(readonly.textContent).toContain("书房小主机");

    // 「消息不排队」（决策 13）没有丢，它搬进了横幅——一件事只说一遍。
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-session-status")).toBe("machineOffline");
    expect(banner.textContent).toMatch(/not queued/i);
    // 只读条不复述横幅那一整段：它只说「等谁」。
    expect(readonly.textContent).not.toMatch(/not queued/i);
  });

  /**
   * 「机器离线」这一档唯一的出口（两端统一）：那条对话钉在一台够不着的机器上、
   * 续轮不会改派，所以横幅给的是「另起一条」，而不是「查看设备」——后者不把人
   * 往前推，横幅刚说完「离线 · 最后在线 3 小时前」，点进去看到的还是那句话。
   *
   * 路由页形态不在 `/chat` 里，所以它靠 URL 把这件事说给那一页听。
   */
  it("机器离线：出口是「新建一个会话」，落到 /chat 的挑 Agent 那一屏", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [offlineDevice] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return framePage([{ seq: 1, text: "离线转录" }]);
      throw new Error("unexpected: " + path);
    });

    renderOfflinePage();
    await screen.findByText(/离线转录/);

    const banner = screen.getByRole("alert");
    fireEvent.click(
      within(banner).getByRole("button", {
        name: i18n.t("sessionStatus.machineOffline.startNew", {
          ns: "agentreUi",
        }),
      }),
    );

    expect(await screen.findByTestId("chat-page")).toBeTruthy();
    expect(screen.getByTestId("chat-search").textContent).toContain(
      "compose=1",
    );
  });

  it("设备已撤销：转录照读，只读的理由与「机器离线」各说各的（决策 7）", async () => {
    const revoked = { ...deviceRow, online: false, status: 0 };
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [revoked] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return framePage([{ seq: 1, text: "撤销之后仍读得到" }]);
      throw new Error("unexpected: " + path);
    });

    renderOfflinePage();

    expect(await screen.findByText(/撤销之后仍读得到/)).toBeTruthy();
    // 撤销是另一种只读态：横幅由 deriveSessionViewStatus 分类（本页只消费）。
    expect(screen.getByRole("alert").getAttribute("data-session-status")).toBe(
      "deviceRevoked",
    );
    // 「永久」这句由横幅说（决策 5）。输入框那一带换成只读条：一个永远灰着的
    // 输入框是在暗示「也许待会儿能用」，而撤销是不可逆的。
    expect(screen.getByRole("alert").textContent).toMatch(/permanent/i);
    const readonly = screen.getByTestId("session-compose-readonly");
    expect(screen.queryByTestId("session-detail-send")).toBeNull();
    expect(readonly.textContent).not.toContain("书房小主机");
  });

  it("机器在线：历史先从镜像取、预置游标，中继才补齐（不重拉 server 已有的那段）", async () => {
    const order: string[] = [];
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript")) {
        order.push("mirror");
        return framePage([
          { seq: 1, text: "镜像里的历史" },
          { seq: 2, text: "镜像里的第二句" },
        ]);
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.setCursor.mockImplementation(() => order.push("setCursor"));
    fakeClient.attach.mockImplementation(async () => {
      order.push("attach");
      return {};
    });
    fakeClient.catchUp.mockImplementation(async () => {
      order.push("catchUp");
      // 中继只补 server 还没有的那一段（seq 3）。
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "中继补上的新一句" },
        seq: 3,
      });
    });

    renderPage();

    expect(await screen.findByText(/镜像里的历史/)).toBeTruthy();
    expect(await screen.findByText(/中继补上的新一句/)).toBeTruthy();
    // 游标预置到镜像交出的最后一个 seq，且必须落在 attach/补齐之前。
    // 第三个参数是这条对话的发起端指纹（中继客户端按 (指纹, 会话 id) 记游标）；
    // 这个 summary 没报 peerFingerprint，因此是 undefined =「调用方自己的对端」。
    expect(fakeClient.setCursor).toHaveBeenCalledWith("42", 2, undefined);
    expect(order.indexOf("mirror")).toBeLessThan(order.indexOf("setCursor"));
    expect(order.indexOf("setCursor")).toBeLessThan(order.indexOf("attach"));
    expect(order.indexOf("attach")).toBeLessThan(order.indexOf("catchUp"));
  });

  /**
   * 中继客户端按 **(发起端指纹, 会话 id)** 记游标与 attach 结果（会话标识各端本地
   * 自增，一台机器上同号的两条对话是常态；机器轴列的正是这一份）。所以清单上学到的
   * origin 必须**每一次**都带回去：少带的那一次访问的是「调用方自己的对端」那一格,
   * 于是预置写在一格、补齐读的是另一格 —— 等于没预置，或者更糟，读到上一条同号
   * 对话留下的游标，整页空白。
   */
  it("清单报了发起端：游标读写与 attach/补齐都带着它，不落到同号的另一条上", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-desktop", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return framePage([{ seq: 1, text: "镜像里的历史" }]);
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [{ ...summary, peerFingerprint: "fp-desktop" }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/镜像里的历史/);

    await vi.waitFor(() => {
      expect(fakeClient.setCursor).toHaveBeenCalledWith("42", 1, "fp-desktop");
    });
    expect(fakeClient.getCursor).toHaveBeenCalledWith("42", "fp-desktop");
    expect(fakeClient.attach).toHaveBeenCalledWith("42", "fp-desktop");
    expect(fakeClient.catchUp).toHaveBeenCalledWith("42", "fp-desktop");
  });

  // 会话标识是各端本地自增、会被复用的：执行端那边被删掉重排之后，日志的高水位比
  // 镜像里这一段低。游标停在它上面的话，此后每一条实时帧都「不大于游标」被当成重复
  // 丢光——会话没有报错、没有跳号地冻住。attach 交回来的 latestSeq 就是执行端的高
  // 水位，按它复位。
  it("执行端的高水位低于镜像那一段：按 attach 交回的 latestSeq 复位游标，不让会话冻住", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return framePage([
          { seq: 1, text: "镜像里的老历史" },
          { seq: 5, text: "镜像里的最后一句" },
        ]);
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    // 页面预置游标之后，客户端的游标就是镜像那一段的末尾。
    fakeClient.setCursor.mockImplementation((_sid: number, seq: number) =>
      fakeClient.getCursor.mockReturnValue(seq),
    );
    // 执行端手里只剩到 seq 2（那条会话被重排过）。
    fakeClient.attach.mockResolvedValue({
      conversationId: "42",
      lifecycleState: "idle",
      latestSeq: 2,
    } as never);

    renderPage();
    await screen.findByText(/镜像里的最后一句/);

    await vi.waitFor(() => {
      expect(fakeClient.setCursor).toHaveBeenCalledWith("42", 5, undefined);
      expect(fakeClient.setCursor).toHaveBeenCalledWith("42", 2, undefined);
    });
  });

  it("机器没有名字：说明退回不点名的那句，不留一个空槽", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return { devices: [{ ...offlineDevice, name: "" }] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return framePage([{ seq: 1, text: "没名字的机器上的转录" }]);
      throw new Error("unexpected: " + path);
    });

    renderOfflinePage();
    await screen.findByText(/没名字的机器上的转录/);

    // 横幅的标题退回不点名的那句，只读条同理——两处都不留一个空槽。
    const banner = screen.getByRole("alert");
    expect(banner.textContent).not.toContain("undefined");
    expect(banner.textContent).toMatch(/This machine is offline/i);
    const readonly = screen.getByTestId("session-compose-readonly");
    expect(readonly.textContent).not.toContain("undefined");
    expect(readonly.textContent).toContain(
      "the machine running this conversation",
    );
  });

  // 发起端与承载这条连接的机器常常不是同一台（同一条对话桌面端与 agentred 各有
  // 一份）。从前这一点会逼出一段猜测：镜像的身份键是 (发起端指纹, 会话号)，而 URL
  // 上只有会话号。现在两处都以 conversation_id 为键，发起端是谁与读不读得到无关。
  it("发起端不是这台机器：照样读得到，寻址不经过发起端", async () => {
    const asked: string[] = [];
    const askedSessions: string[] = [];
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [offlineDevice] };
      if (path.startsWith("/v1/agent-sessions?")) {
        // 认领改成按会话号精确查（规格 2026-08-19 决策 13）：拉全份再本地筛的那条
        // 路在分页之后会漏掉本来存在的对话。替身照着端点来——只回该号的那些。
        askedSessions.push(path);
        const id = new URL(path, "http://x").searchParams.get(
          "conversation_id",
        );
        const rows = [
          { peer_fingerprint: "fp-desktop-9", conversation_id: "42" },
          { peer_fingerprint: "fp-desktop-9", conversation_id: "7" },
        ].filter((r) => !id || r.conversation_id === id);
        return { total: rows.length, items: rows };
      }
      if (path.startsWith("/v1/agent-sessions/transcript")) {
        asked.push(path);
        return framePage([{ seq: 1, text: "桌面端发起的那条" }]);
      }
      throw new Error("unexpected: " + path);
    });

    renderOfflinePage();

    expect(await screen.findByText(/桌面端发起的那条/)).toBeTruthy();
    expect(asked[0]).toContain("conversation_id=42");
    expect(asked[0]).not.toContain("peer_fingerprint");
    // 精确查而不是拉全份：conversation_id 全局唯一，这条路至多命中一行。
    expect(askedSessions.some((p) => p.includes("conversation_id=42"))).toBe(
      true,
    );
  });

  // 从前这里守的是一段**猜测**：镜像身份是 (发起端指纹, 会话号)，URL 上只有会话号，
  // 于是同号对话有多条时「不猜、如实说读不到」。`conversation_id` 全局唯一之后那种
  // 歧义**由构造消失**——账号里至多一行，读不到只可能是真没有。
  //
  // 换下来的这一条守它的后继：账号里没有这条对话时（机器轴上没保存过的那些）不
  // 谎报成空转录，离线时如实说读不到。
  it("账号里没有这条对话且机器离线：如实说读不到，不摆一份空转录", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [offlineDevice] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return framePage([]);
      throw new Error("unexpected: " + path);
    });

    renderOfflinePage();

    await screen.findByTestId("session-history-unavailable");
    expect(screen.queryByTestId("session-detail-composer")).toBeNull();
  });

  // Given 一条会话正在输出；When 在桌面右栏切到另一条会话再切回来；Then 刚才那几帧
  // 只能出现一次。
  //
  // 切换是同实例换 props：渲染期重置把 `events` 清空、`history.settled` 打回 false，
  // 于是镜像历史要重取一遍。但**中继客户端没换也没 detach**（同一台机器就是同一个
  // client），它对这条会话仍在关注名单上，实时帧在镜像那一趟 HTTP 还没回来时就已经
  // 落进刚清空的 `events` 了。镜像那一段随后原样前插——它覆盖的正是同一段 seq，
  // 屏幕上就是同一句话说两遍。
  //
  // 首屏没有这个洞：那时客户端还没 attach（attach 排在 history.settled 之后），
  // 实时帧不可能抢在镜像前面。所以这条只在「切走再切回」这条路上成立。
  it("输出中切走再切回：镜像历史不与已经收到的实时帧重复", async () => {
    let mirrorCalls = 0;
    let releaseSecond = () => {};
    const secondPage = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path.startsWith("/v1/agent-sessions/transcript")) {
        if (path.includes("conversation_id=43")) return framePage([]);
        mirrorCalls += 1;
        // 第二趟（切回来那一次）压住不回，好让实时帧先落地——这正是真实时序：
        // 客户端还连着，HTTP 要一个来回。
        if (mirrorCalls >= 2) await secondPage;
        return mirrorCalls >= 2
          ? // 切回来时镜像已经跟到了第二帧。
            framePage([
              { seq: 1, text: "第一句" },
              { seq: 2, text: "输出中的一句" },
            ])
          : framePage([{ seq: 1, text: "第一句" }]);
      }
      if (path.startsWith("/v1/agent-sessions?")) {
        const id = path.includes("conversation_id=43") ? "43" : "42";
        return { items: [{ peer_fingerprint: "fp-1", conversation_id: id }] };
      }
      // 其余端点（agents / 已读回执 …）不是本条的判据，如实回空即可。
      return {};
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      return {};
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    const at = (conversationId: string) => (
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId={conversationId}
            form="embedded"
          />
        </ThemeProvider>
      </MemoryRouter>
    );

    const { rerender } = render(at("42"));
    await screen.findByText(/第一句/);

    rerender(at("43"));
    await vi.waitFor(() => expect(screen.queryByText(/第一句/)).toBeNull());

    rerender(at("42"));
    // 客户端一直连着这条会话，输出继续推过来——镜像那一趟还在路上。
    await vi.waitFor(() => expect(mirrorCalls).toBe(2));
    act(() => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "输出中的一句" },
        seq: 2,
      });
    });
    // 这一刻转录还没显示出来（history.loaded 要等镜像那一趟），但帧已经在
    // `events` 里了 —— 镜像一落地两边一起画出来，重复就是在那一刻现形的。
    releaseSecond();

    await screen.findByText(/第一句/);
    await vi.waitFor(() => {
      const said = (text: string) =>
        (
          screen.getByTestId("session-detail-transcript").textContent ?? ""
        ).split(text).length - 1;
      expect(said("第一句")).toBe(1);
      expect(said("输出中的一句")).toBe(1);
    });
  });
});

/**
 * 三带布局（2026-08-20 对话页 UI/UX 改版）。
 *
 * 此前详情是**一整块滚动区**：头部、转录、审批、Composer 依次排下来，整块
 * `overflow-y-auto`。后果是转录一长，Composer 就跟着被卷出屏幕——量下来页面
 * 高 2145px、视口 900px，输入框在折线以下 1245px。要回复得先滚到底，而转录还在
 * 往下长，等于永远追不上。
 *
 * 改成三带：头部与 Composer 各自 `shrink-0` 钉住，只有中间那一带滚。这里守的是
 * **DOM 归属**（jsdom 不算布局）：Composer 与头部都不在滚动容器里。
 */
describe("会话详情：头部 / 转录 / Composer 三带", () => {
  function stubReady() {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "很长的一段转录" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
  }

  it("嵌入形态：只有转录那一带滚，头部与 Composer 都在滚动容器之外", async () => {
    stubReady();
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await screen.findByText("很长的一段转录");
    const scroll = screen.getByTestId("session-detail-scroll");
    expect(scroll.contains(screen.getByText("很长的一段转录"))).toBe(true);
    expect(scroll.contains(screen.getByTestId("session-detail-composer"))).toBe(
      false,
    );
    expect(scroll.contains(screen.getByTestId("session-detail-header"))).toBe(
      false,
    );
  });

  it("页面形态同样是三带：移动端打开一条长对话，输入框不会被转录卷走", async () => {
    stubReady();
    renderPage();

    await screen.findByText("很长的一段转录");
    const scroll = screen.getByTestId("session-detail-scroll");
    expect(scroll.contains(screen.getByText("很长的一段转录"))).toBe(true);
    expect(scroll.contains(screen.getByTestId("session-detail-composer"))).toBe(
      false,
    );
  });
});

/**
 * 详情头部（2026-08-20 对话页 UI/UX 改版）。
 *
 * 此前头部只有三样：标题、一枚状态胶囊、「机器 · 在线」。打开一条对话看不出它
 * 是哪个 Agent 在跑、上一次动是什么时候，也没有任何办法把跑飞的一轮停下来 ——
 * 而 wire 上 `runtime.abort` 一直都在。
 *
 * 与桌面端 chat-panel 的 toolbar 同形：头像 + 两行（标题 / mono meta 行）+ 停止。
 * **项目**那一维不摆：SessionSummary 上没有它（只有账号镜像那一行有），
 * 摆一个猜出来的项目名比不摆更糟。
 */
describe("会话详情：头部", () => {
  const workspaceAgents = [
    {
      sync_id: "ag-1",
      name: "后端 Agent",
      avatar_color: "agent-3",
      avatar_icon: "bot",
    },
  ];

  function stubHeader(
    agents: {
      sync_id: string;
      name: string;
      avatar_color?: string;
      avatar_icon?: string;
    }[] = workspaceAgents,
  ) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [{ ...summary, lifecycleState: "running" }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeAbort) return {};
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "跑着呢" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
  }

  function renderEmbeddedDetail(headerRight?: ReactNode) {
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId="42"
            form="embedded"
            headerRight={headerRight}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  /*
    嵌入形态（桌面 Chat 右栏）里这个头部**就是**那一页的顶带：外面没有壳的顶栏
    托着它了。此前它是 `py-2.5` 外层套一个恒高 68px 的身份行，那圈外层内边距是
    给面包屑那一行留的，而面包屑只在路由页形态渲染 —— 嵌进 Chat 里时它把 68px
    撑成 89px，什么都没多装。桌面端同形的 chat-panel-header 一直是平的 68px。
  */
  it("嵌入形态的头部是平的 68px：没有面包屑就没有那圈外层内边距", async () => {
    stubHeader();
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const head = screen.getByTestId("session-detail-header");
    expect(head.className).toMatch(/h-\[68px\]/);
    expect(head.className).not.toMatch(/py-/);
    // 面包屑是路由页形态独有的，嵌入形态本来就不该有。
    expect(within(head).queryByRole("navigation")).toBeNull();
  });

  /*
    顶带合并之后，页面级那簇控件（连接态 + 语言/主题）没有别的落点：Chat 把它们
    递进来，摆在这一行的最右端——与「停止」同一带。
  */
  it("headerRight 递进来的那簇控件落在头部右端", async () => {
    stubHeader();
    renderEmbeddedDetail(<button type="button">page-chrome</button>);

    await screen.findByText("跑着呢");
    const head = screen.getByTestId("session-detail-header");
    expect(
      within(head).getByRole("button", { name: "page-chrome" }),
    ).toBeTruthy();
  });

  /*
    身份认不出来时那一格**照样占住**（桌面端 chat-panel-header 的同一条）：
    `/v1/workspace/agents` 还没回来、或者这条老会话上根本没有 agentSyncId 时，
    此前这一格整个不渲染，标题于是横向跳一格（32px 头像 + 12px 间距）——同一条
    对话打开的头一瞬和之后长得不一样。
  */
  it("认不出 Agent 时头像那一格仍占住，标题不横向跳一格", async () => {
    // 账号里一个 Agent 都答不出来 → 头部解不出身份。
    stubHeader([]);
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const band = screen.getByTestId("session-detail-identity");
    expect(within(band).queryByRole("img")).toBeNull();
    const slot = band.querySelector('[data-testid="session-detail-avatar"]');
    expect(slot).toBeTruthy();
    expect((slot as HTMLElement).className).toContain("size-8");
  });

  it("头部说得出是哪个 Agent 在跑，头像上的是那个 Agent 的调色板色", async () => {
    stubHeader();
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const head = screen.getByTestId("session-detail-header");
    expect(head.textContent).toContain("后端 Agent");
    // 头像是可读的 role=img，不是一个只有颜色的方块（头部与转录各一枚，取头部这枚）。
    const avatar = within(head).getByRole("img", { name: "后端 Agent" });
    // token 要落成 CSS 变量再进 backgroundColor —— 直接塞 token 等于没上色。
    expect(avatar.style.backgroundColor).toBe("var(--agent-3)");
  });

  /**
   * Agent 自己选的图标（`avatar_icon`）与项目那一维同一条：词表与解 key 都在共享包
   * 里，本站只要把 key 递下去。此前这一格根本没读，于是组织面详情画得出图标、
   * 对话里同一个 Agent 还是一个字。
   */
  it("Agent 选过图标时头部与转录画的都是那一枚，不是首字", async () => {
    stubHeader();
    const { container } = renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const head = screen.getByTestId("session-detail-header");
    const avatar = within(head).getByRole("img", { name: "后端 Agent" });
    expect(avatar.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-bot",
    );
    // 转录里那一枚是同一个身份记号，不该一处有图标一处没有。
    const inTranscript = container.querySelector(
      '[data-testid="session-detail-transcript"] [role="img"] svg',
    );
    expect(inTranscript?.getAttribute("class")).toContain("lucide-bot");
  });

  /**
   * 没设过颜色的 Agent（同步载荷里根本没有 avatar_color）是常态，不是异常：
   * 桌面端不逼用户选色。此前这一档退化成「不给 backgroundColor」，方块透明，
   * 白色首字母落在深色底上 —— 看起来就是一枚黑方块，而同一个 Agent 在左栏
   * 索引里是蓝的（那边走共享包的 AgentAvatar，缺色退回 agent-1）。
   */
  it("Agent 没设颜色：头像退回调色板首色，不是一枚透明方块", async () => {
    stubHeader([{ sync_id: "ag-1", name: "后端 Agent" }]);
    const { container } = renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const head = screen.getByTestId("session-detail-header");
    const avatar = within(head).getByRole("img", { name: "后端 Agent" });
    expect(avatar.style.backgroundColor).toBe("var(--agent-1)");
    // 转录里那一枚同理：两处是同一个身份记号，不该一处有底色一处没有。
    const inTranscript = container.querySelector(
      '[data-testid="session-detail-transcript"] [role="img"]',
    );
    expect((inTranscript as HTMLElement | null)?.style.backgroundColor).toBe(
      "var(--agent-1)",
    );
  });

  it("meta 行只在真的有前一段时才摆分隔符（老会话没有状态/时间，不该留一个孤零零的「·」）", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        // 还没跑过第一轮的会话：没有标题、没有 agentSyncId、没有活动时间。
        return {
          sessions: [
            {
              conversationId: "42",
              lifecycleState: "",
              latestSeq: 2,
              cwd: "/home/agent/proj",
            },
          ],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "老会话" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    renderEmbeddedDetail();

    await screen.findByText("老会话");
    const meta = screen.getByTestId("session-detail-meta").textContent ?? "";
    expect(meta.startsWith("·")).toBe(false);
    expect(meta).toContain("书房小主机");
  });

  /**
   * 机器离线时头部同样要认得出这条对话。摘要此前只有中继 session.list 一条来路，
   * 机器不在线就永远是 null —— 标题于是退成 `#42`，Agent 名与头像一并消失，而
   * 账号镜像那一行（/v1/agent-sessions）本来就带着 title / agent_sync_id。
   * 转录读得到、标题却读不到，是同一份数据被丢在了半路上。
   */
  it("机器离线：标题与 Agent 身份改从账号镜像那一行认，不退成 #<会话号>", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: false }] };
      if (path === "/v1/workspace/agents") return { agents: workspaceAgents };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [
            {
              peer_fingerprint: "fp-1",
              conversation_id: "42",
              title: "重构登录页",
              agent_sync_id: "ag-1",
              lifecycle_state: "idle",
              last_message_at: 1754000000000,
            },
          ],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return {
          frames: [
            {
              seq: 1,
              method: "runtime.event",
              params: {
                conversationId: "42",
                event: { kind: "text_delta", text: "离线转录" },
              },
            },
          ],
          cursor: 1,
          has_more: false,
        };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    renderEmbeddedDetail();

    await screen.findByText(/离线转录/);
    const head = screen.getByTestId("session-detail-header");
    // 标题是真标题，不是 #<会话号> 那个占位。
    expect(head.textContent).toContain("重构登录页");
    expect(head.textContent).not.toContain("#42");
    // Agent 身份同样认得出：名字 + 那枚带调色板色的头像。
    expect(head.textContent).toContain("后端 Agent");
    const avatar = within(head).getByRole("img", { name: "后端 Agent" });
    expect(avatar.style.backgroundColor).toBe("var(--agent-3)");
  });

  /**
   * 转录里每条消息头上的时间。
   *
   * 这一侧的转录是从帧现折的：时刻只能由帧带来，而帧上这一格从前根本不存在，于是
   * 共享包的 `formatHHmm(0)` 返回空串 —— 控制台上每条消息都没有时间，同一条对话在
   * 桌面端却有（那边读的是自己库里的 chat_messages.createtime）。
   *
   * 走的是**镜像**这条路：一页 JournaledNotification 上的 createtime 要一路穿过
   * applyJournalFrames → toTranscriptFrame → 共享归约器，落到消息上。
   */
  it("镜像的一页带 createtime：转录里每条消息头上出 HH:mm", async () => {
    const at = new Date(2026, 8, 1, 9, 41, 7).getTime();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: false }] };
      if (path === "/v1/workspace/agents") return { agents: workspaceAgents };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [
            {
              peer_fingerprint: "fp-1",
              conversation_id: "42",
              title: "重构登录页",
              agent_sync_id: "ag-1",
              lifecycle_state: "idle",
            },
          ],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return {
          frames: [
            {
              seq: 1,
              createtime: at,
              method: "runtime.event",
              params: {
                conversationId: "42",
                event: { kind: "user_message", text: "离线转录" },
              },
            },
          ],
          cursor: 1,
          has_more: false,
        };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    renderEmbeddedDetail();

    await screen.findByText(/离线转录/);
    expect(screen.getByText("09:41")).toBeTruthy();
  });

  /**
   * 转录抬头的「助手」闪一下：Agent 名要两条异步各自到齐才解得开（账号的 Agent 清单
   * + 这条对话的 agentSyncId），而转录只要有消息就先铺出来了。中间那一段空窗里
   * 共享包按约定退回中性抬头「Assistant」，等清单落地再换成真名 —— 用户看到的就是
   * 名字和头像跳了一下。
   *
   * 转录不该为了等一个名字而扣着不显示（内容比抬头重要），所以要的不是「更快解开」，
   * 而是**在解得开之前不摆一个会被换掉的名字**。
   */
  it("Agent 清单还在路上：转录抬头不先摆「Assistant」再换成真名", async () => {
    let releaseAgents: (v: unknown) => void = () => {};
    const agentsPending = new Promise((r) => {
      releaseAgents = r;
    });
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: false }] };
      // 账号的 Agent 清单故意晚于转录落地（真实网络里这完全可能）。
      if (path === "/v1/workspace/agents") {
        await agentsPending;
        return { agents: workspaceAgents };
      }
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [
            {
              peer_fingerprint: "fp-1",
              conversation_id: "42",
              title: "重构登录页",
              agent_sync_id: "ag-1",
              lifecycle_state: "idle",
            },
          ],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return {
          frames: [
            {
              seq: 1,
              method: "runtime.event",
              params: {
                conversationId: "42",
                event: { kind: "text_delta", text: "离线转录" },
              },
            },
          ],
          cursor: 1,
          has_more: false,
        };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    renderEmbeddedDetail();

    // 转录已经铺出来了 —— 而 Agent 清单还没回来。
    await screen.findByText(/离线转录/);
    const transcript = screen.getByTestId("session-detail-transcript");
    // 这一刻**已知**这条对话有 Agent（agentSyncId 在手），只是名字还没解开：
    // 此时摆「Assistant」就是摆一个注定要被换掉的名字。
    expect(transcript.textContent).not.toContain("Assistant");

    // 清单落地后，真名补上。
    releaseAgents(undefined);
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("session-detail-transcript").textContent,
      ).toContain("后端 Agent"),
    );
  });

  /**
   * 没有标题的会话（发起端还没报过 title）在索引上退化为
   * 「工作目录 · 后端 · 状态」——那是本站关于「这条对话叫什么」的唯一一处派生
   * （lib/sessionView 的 sessionTitle，索引与总览都走它）。详情页却另写了一份
   * `#<会话号>`：同一条对话在列表里叫一个名字、点进去叫另一个。
   *
   * 标题该由那一处说了算，详情页不另立一套。
   */
  it("没有标题的会话：头部与索引同一套派生，不另写一个 #<会话号>", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: false }] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [
            {
              peer_fingerprint: "fp-1",
              conversation_id: "42",
              // 老会话：没有 title，也没有 agent_sync_id。
              backend_type: "claude",
              lifecycle_state: "idle",
            },
          ],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return {
          frames: [
            {
              seq: 1,
              method: "runtime.event",
              params: {
                conversationId: "42",
                event: { kind: "text_delta", text: "老会话转录" },
              },
            },
          ],
          cursor: 1,
          has_more: false,
        };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    renderEmbeddedDetail();

    await screen.findByText(/老会话转录/);
    const head = screen.getByTestId("session-detail-header");
    // 与索引同一套退化：后端与状态说得出来，cwd 永不下行（R19）所以是「—」。
    expect(head.textContent).toContain("claude");
    expect(head.textContent).not.toContain("#42");
  });

  it("跑着的那一轮停得下来：头部的「停止」真的发 runtime.abort", async () => {
    stubHeader();
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    fireEvent.click(screen.getByTestId("session-detail-stop"));

    await vi.waitFor(() =>
      expect(
        fakeClient.request.mock.calls.some(
          (c) => c[0] === rpcMethods.runtimeAbort,
        ),
      ).toBe(true),
    );
  });

  /*
    项目那一维（桌面端 chat-panel-header 的 topline 说的就是它）。

    此前这一行只有「Agent · 时间 · 机器」：同一条对话在左栏索引的行上带着项目
    （RowSecondaryLine 的 project 那一段），点进来项目就没了 —— 而项目恰恰是
    「这条对话在动谁的代码」这句话里最要紧的一维。

    协议上它一直在：wire 的 SessionSummary 有 projectSyncId（发起端自己报的），
    账号镜像那一行有 project_sync_id（服务端按 cwd 与项目树就地判定，决策 12）。
    名字与颜色则要拿它去问账号的项目树 —— 与 Agent 名同一种取法。
  */
  const projectRows = [
    { sync_id: "p-1", name: "登录重构", color: "agent-5" },
    { sync_id: "p-2", name: "别的项目", color: "agent-2" },
  ];

  /** stubHeader 的项目版：会话上钉了 p-1，账号项目树答得出它。 */
  function stubHeaderWithProject(
    projects: {
      sync_id: string;
      name: string;
      color?: string;
      icon?: string;
    }[] = projectRows,
    projectSyncId = "p-1",
  ) {
    stubHeader();
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: workspaceAgents };
      if (path === "/v1/workspace/projects") return { projects };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [{ ...summary, lifecycleState: "running", projectSyncId }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
  }

  it("会话属于某个项目：meta 行说得出项目名，位置在 Agent 与机器之间", async () => {
    stubHeaderWithProject();
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const seg = await screen.findByTestId("session-detail-meta-project");
    expect(seg.textContent).toContain("登录重构");
    // 索引四个轴上说维的顺序是 Agent → 项目 → 机器，头部不另立一套。
    const meta = screen.getByTestId("session-detail-meta");
    expect(
      [...meta.querySelectorAll("[data-testid^='session-detail-meta-']")].map(
        (el) => el.getAttribute("data-testid"),
      ),
    ).toEqual([
      "session-detail-meta-agent",
      "session-detail-meta-project",
      "session-detail-meta-machine",
    ]);
  });

  /*
    项目在索引里有**唯一**一枚字形（共享包的 ProjectGlyph：组头 24px、行首 14px、
    时间轴第二行那一半）。头部是它的第四处出现，不能在这里画一枚通用文件夹图标 ——
    那样同一个项目在左栏是橙方块、在头部是灰文件夹，认不出是同一个。
  */
  it("项目那一段带的是共享包那枚项目字形，颜色取项目自己的调色板色", async () => {
    stubHeaderWithProject();
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const seg = await screen.findByTestId("session-detail-meta-project");
    const glyph = within(seg).getByRole("img", { name: "登录重构" });
    expect(glyph.style.backgroundColor).toBe("var(--agent-5)");
  });

  it("项目选过图标时头部画的也是那一枚：四处出现必须是同一个记号", async () => {
    // 组头 / 行首 / 时间轴第二行都已经画得出项目自己的图标（解 key 那一步在共享包
    // 里），头部只把 icon 一起递下去就行 —— 少递这一格，同一个项目在头部就退回首字。
    stubHeaderWithProject([
      { sync_id: "p-1", name: "登录重构", color: "agent-5", icon: "code-xml" },
    ]);
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const seg = await screen.findByTestId("session-detail-meta-project");
    const glyph = within(seg).getByRole("img", { name: "登录重构" });
    expect(glyph.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-code-xml",
    );
  });

  it("不属于任何项目的对话：不摆项目那一段，也不留一个孤零零的「·」", async () => {
    stubHeaderWithProject(projectRows, "");
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    expect(screen.queryByTestId("session-detail-meta-project")).toBeNull();
    const meta = screen.getByTestId("session-detail-meta").textContent ?? "";
    expect(meta.startsWith("·")).toBe(false);
  });

  /*
    项目树还没落地、或那个项目已经不在账号里：解不出名字就不摆这一段。摆一个
    猜出来的项目名（比如 sync id 本身）比不摆更糟。
  */
  it("项目树里没有这条对话钉的那个项目：不摆项目那一段，不拿 sync id 顶上", async () => {
    stubHeaderWithProject([{ sync_id: "p-2", name: "别的项目" }], "p-1");
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    expect(screen.queryByTestId("session-detail-meta-project")).toBeNull();
    expect(
      screen.getByTestId("session-detail-meta").textContent ?? "",
    ).not.toContain("p-1");
  });

  /*
    机器离线时中继给不出摘要，头部认这条对话全靠账号镜像那一行 —— 项目也一样。
    镜像那一格是服务端按 cwd 就地判定出来的，正是 agentred 那种自己不记项目的
    发起端唯一说得出项目的来路。
  */
  it("机器离线：项目改从账号镜像那一行的 project_sync_id 认", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return { devices: [{ ...deviceRow, online: false }] };
      if (path === "/v1/workspace/agents") return { agents: workspaceAgents };
      if (path === "/v1/workspace/projects") return { projects: projectRows };
      if (path.startsWith("/v1/agent-sessions?"))
        return {
          total: 1,
          items: [
            {
              peer_fingerprint: "fp-1",
              conversation_id: "42",
              title: "重构登录页",
              agent_sync_id: "ag-1",
              project_sync_id: "p-1",
              lifecycle_state: "idle",
            },
          ],
        };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return {
          frames: [
            {
              seq: 1,
              method: "runtime.event",
              params: {
                conversationId: "42",
                event: { kind: "text_delta", text: "离线转录" },
              },
            },
          ],
          cursor: 1,
          has_more: false,
        };
      throw new Error("unexpected: " + path);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    renderEmbeddedDetail();

    await screen.findByText(/离线转录/);
    expect(
      (await screen.findByTestId("session-detail-meta-project")).textContent,
    ).toContain("登录重构");
  });

  /*
    窄档降级（决策 4）：机器先收（560px），项目其次（420px，与桌面端 topline 同一
    个断点）—— 两维在左栏索引的行上都还说得出，Agent 与状态不能收。
  */
  it("面板变窄：项目那一段在机器之后被收起，不折行", async () => {
    stubHeaderWithProject();
    renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    expect(screen.getByTestId("session-detail-meta-project").className).toMatch(
      /@max-\[420px\]\/header:hidden/,
    );
  });

  it("转录里的头像也换成这个 Agent 的调色板色（此前是中性的 bg-muted）", async () => {
    stubHeader();
    const { container } = renderEmbeddedDetail();

    await screen.findByText("跑着呢");
    const inTranscript = container.querySelector(
      '[data-testid="session-detail-transcript"] [role="img"]',
    );
    expect((inTranscript as HTMLElement | null)?.style.backgroundColor).toBe(
      "var(--agent-3)",
    );
  });
});

/**
 * 输入框（2026-08-20 对话页 UI/UX 改版）。
 *
 * 此前是一个裸 `<textarea>`：没有 @ 提及、没有 / 命令，也没有任何关于「按什么键
 * 发出去」的提示。桌面端用的是共享包的 `AIChatInput`，两端因此不是同一种输入框。
 *
 * 占位文案由 `AIChatInput` 自己按**本次真正接上的能力**拼（省略 `placeholder` 时
 * 生效）。这一端接不上 `!` 执行终端命令（wire 上没有任何 PTY / 本地执行方法），
 * 所以显式传 `localCommandsEnabled={false}` —— 光看「接没接 onCommandSubmit」会
 * 判成能用，而这里接它只为挡住静默吞字。
 */
describe("会话详情：输入框", () => {
  function stubComposer() {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents")
        return {
          agents: [
            { sync_id: "ag-1", name: "后端 Agent", avatar_color: "agent-3" },
          ],
        };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "开场白" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
  }

  function renderComposer() {
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("用的是共享包的 AIChatInput：打字 + Enter 照常发得出去", async () => {
    stubComposer();
    renderComposer();

    await screen.findByText("开场白");
    await sendInComposer("把按钮改成蓝色");

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        (c) => c[0] === rpcMethods.runtimeRun,
      );
      expect(call?.[1]).toMatchObject({ userText: "把按钮改成蓝色" });
    });
  });

  it("占位文案按真正接上的能力拼：@ 与 / 在，! 不许诺（这一端没有本地执行）", async () => {
    stubComposer();
    const { container } = renderComposer();

    await screen.findByText("开场白");
    const placeholder = container
      .querySelector("[data-placeholder]")
      ?.getAttribute("data-placeholder");
    expect(placeholder).toBe("Type a message · @ to mention · / for commands");
  });

  it("底栏摆出上下文用量：窗口与用量都从中转事件流里来（此前是记而不显）", async () => {
    stubComposer();
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "开场白" },
        seq: 1,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "context_window_updated", tokens: 200000 },
        seq: 2,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "usage", totalInputTokens: 41200 },
        seq: 3,
      });
    });
    renderComposer();

    await screen.findByText("开场白");
    const meter = await screen.findByTestId("composer-context-meter");
    // 41200 / 200000 = 20.6% → 21%
    expect(meter.textContent).toContain("21%");
    // 环画的是比例，读数挂在 aria 上：底栏里不再摆 token 绝对值（与桌面端同形）。
    expect(meter.getAttribute("aria-label")).toBe(
      "Context usage 41.2k / 200k, 21% used",
    );
  });

  /**
   * 与桌面端 `chat.tsx` 的 ContextMeter 同形（2026-08-21 改环）：底栏只留一枚环 +
   * 百分比，token 绝对值搬进 hover 浮窗。此前本站是 40px 线性条 + 原生 title：
   * title 只有鼠标拿得到，键盘用户读不到那两个数字。
   */
  it("上下文计量器是一枚环 + 百分比，不是线性条，也不靠原生 title 藏数字", async () => {
    stubComposer();
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "开场白" },
        seq: 1,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "context_window_updated", tokens: 200000 },
        seq: 2,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "usage", totalInputTokens: 41200 },
        seq: 3,
      });
    });
    renderComposer();

    await screen.findByText("开场白");
    const meter = await screen.findByTestId("composer-context-meter");
    expect(meter.tagName).toBe("BUTTON");
    expect(meter.hasAttribute("title")).toBe(false);
    expect(meter.textContent).not.toContain("41");
    const ring = within(meter).getByRole("progressbar");
    expect(ring.getAttribute("aria-valuenow")).toBe("41200");
    expect(ring.getAttribute("aria-valuemax")).toBe("200000");
    expect(
      ring
        .querySelector("[data-slot='context-ring-arc']")
        ?.classList.contains("stroke-primary"),
    ).toBe(true);
  });

  it("聚焦计量器就展开浮窗：已用 / 上限 / 剩余都在里面，键盘也拿得到", async () => {
    stubComposer();
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "开场白" },
        seq: 1,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "context_window_updated", tokens: 200000 },
        seq: 2,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "usage", totalInputTokens: 41200 },
        seq: 3,
      });
    });
    renderComposer();

    await screen.findByText("开场白");
    fireEvent.focusIn(await screen.findByTestId("composer-context-meter"));

    expect(await screen.findByText("41.2k")).toBeTruthy();
    expect(screen.getByText("/ 200k")).toBeTruthy();
    expect(screen.getByText("Remaining")).toBeTruthy();
    expect(screen.getByText("159k")).toBeTruthy();
  });

  it("过了 75% 就换告警色：与桌面端同一套 90 / 75 分级，此前本站只有 90 一档", async () => {
    stubComposer();
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "开场白" },
        seq: 1,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "context_window_updated", tokens: 200000 },
        seq: 2,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "usage", totalInputTokens: 164000 },
        seq: 3,
      });
    });
    renderComposer();

    await screen.findByText("开场白");
    const meter = await screen.findByTestId("composer-context-meter");
    expect(
      within(meter)
        .getByRole("progressbar")
        .querySelector("[data-slot='context-ring-arc']")
        ?.classList.contains("stroke-status-waiting"),
    ).toBe(true);
    expect(meter.textContent).toContain("82%");
  });

  it("窗口还没探到时整块不摆：不拿一个编出来的分母画进度条", async () => {
    stubComposer();
    renderComposer();

    await screen.findByText("开场白");
    await awaitComposer();
    expect(screen.queryByTestId("composer-context-meter")).toBeNull();
  });

  it("底栏说得出按什么键发出去（与桌面端逐字一致）", async () => {
    stubComposer();
    renderComposer();

    await screen.findByText("开场白");
    // 这句现在由共享包出（两端同一份文案），所以按可见文字断言而不是找宿主
    // 自己的 testid —— 包不该知道某个宿主的测试怎么写。
    expect(screen.getByText("↵ Send · ⇧↵ New line")).toBeTruthy();
  });

  it("以 ! 开头的一行不会被静默吞掉：如实说这一端执行不了，文本还留在框里", async () => {
    stubComposer();
    renderComposer();

    await screen.findByText("开场白");
    await sendInComposer("!!! 这条很重要");

    // 共享包在缺 onCommandSubmit 时会把 `!` 开头的内容 clearContent 掉、既不发也不
    // 说 —— 用户打的字凭空消失。这一端接不上本地执行（wire 上没有 PTY 方法），
    // 所以必须如实说出来，并且把文本还回去。
    expect(
      await screen.findByTestId("composer-local-command-unsupported"),
    ).toBeTruthy();
    await vi.waitFor(() => expect(composerText()).toBe("!!! 这条很重要"));
    expect(
      fakeClient.request.mock.calls.some((c) => c[0] === rpcMethods.runtimeRun),
    ).toBe(false);
  });
});

/**
 * 打开即已读（2026-08-20 对话页 UI/UX 改版）。
 *
 * 「未读」这一档要成立，得有人在你真的看到这条对话时把这件事记下来。身份键是
 * **发起端**指纹 + 那一端的会话标识（决策 17），与账号镜像其余端点同一组 —— 用
 * 承载连接的那台机器的指纹会记到另一条对话上。
 */
describe("会话详情：打开即标记已读", () => {
  /** 嵌入形态挂一次（宿主能递 onMarkedRead 的那一档就是它）。 */
  function mountEmbedded(
    props: { onMarkedRead?: (id: string, at: number) => void } = {},
  ) {
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId="42"
            form="embedded"
            {...props}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  // 从前这条守的是「四格次序里索引行那一格最优先」：已读的身份是发起端指纹，凑错
  // 就记在别的对话上。身份换成 conversation_id 之后没有可凑的东西了——这一条改守
  // 「不管实时连接那一端报的是谁，记的都是这条对话本身」。
  it("实时会话报的对端指纹不参与已读的身份", async () => {
    const posted: unknown[] = [];
    const onMarkedRead = vi.fn();
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/agent-sessions/read" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { last_read_at: 1_700_000_000_000 };
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          // 这是承载实时连接的另一端；账号镜像的身份已经由索引行给出。
          sessions: [{ ...summary, peerFingerprint: "fp-relay-peer" }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });

    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView
            deviceId={1}
            conversationId="42"
            peerFingerprint="fp-index-origin"
            form="embedded"
            onMarkedRead={onMarkedRead}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(posted).toEqual([{ conversation_id: "42" }]));
    // 交回宿主的也是这条对话的身份：宿主手里那一行的键就是它。
    expect(onMarkedRead).toHaveBeenCalledTimes(1);
    expect(onMarkedRead).toHaveBeenCalledWith("42", 1_700_000_000_000);
  });

  it("打开一条对话时按这条对话的身份记一次已读", async () => {
    const posted: unknown[] = [];
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/agent-sessions/read" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { last_read_at: 1_700_000_000_000 };
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [{ ...summary, peerFingerprint: "fp-desktop" }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });

    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await vi.waitFor(() =>
      // 身份就是 conversation_id 一个值（决策 1）：从前这里还要按四格次序凑一个
      // 发起端指纹，凑错就把已读记在一条账号里不存在的对话上。
      expect(posted).toEqual([{ conversation_id: "42" }]),
    );
  });

  it("同一条对话不重复记：换一条才再记一次", async () => {
    const posted: unknown[] = [];
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/agent-sessions/read" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { last_read_at: 1 };
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [summary, { ...summary, conversationId: "43" }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });

    const { rerender } = render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    // 同一条重渲染不再记一次。
    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(posted).toHaveLength(1);

    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="43" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(posted).toHaveLength(2));
  });

  // ── 开着的那条对话不该在你眼前变回未读 ──────────────────────────────────
  //
  // 已读只在 attach 那一刻记一次,而「未读」的判据是 `last_message_at > last_read_at`
  // ——你正盯着它跑完的这一轮把 last_message_at 推到了已读时刻之后,于是左栏那一行
  // 当着你的面重新亮起「未读」黄点。桌面端同一处的做法是 lastMessageAt 每推进一次
  // 就补记一次(chat-panel 的 mark-read effect),这一端缺的就是「推进时补记」。
  it("Given 打开着这条对话 When 一轮跑完 Then 把已读推到这一轮之后", async () => {
    const posted: unknown[] = [];
    const onMarkedRead = vi.fn();
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/agent-sessions/read" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { last_read_at: 1_700_000_000_000 + posted.length };
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });

    mountEmbedded({ onMarkedRead });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    // 补齐跑完 → ready:回放来的终态帧不算数(见下一条),这一档要等它之后。
    await vi.waitFor(() => expect(fakeClient.catchUp).toHaveBeenCalled());
    await act(async () => {});

    act(() => capturedOpts.onRunResultDone?.({} as never));

    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ conversation_id: "42" });
    // 宿主那一行也要跟着搬:徽标在它手上。
    expect(onMarkedRead).toHaveBeenLastCalledWith("42", 1_700_000_000_002);
  });

  // 补齐会把历史里的每一个终态帧都经 onRunResultDone 回放一遍(见 attach 那一段的
  // 说明)。拿回放去补记已读,就是打开一条有 40 轮历史的对话时连发 40 次 POST。
  it("Given 补齐回放历史的终态帧 Then 不跟着补记已读", async () => {
    const posted: unknown[] = [];
    mockedApi.mockImplementation(async (path, init) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/agent-sessions/read" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { last_read_at: 1 };
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onRunResultDone?.({} as never);
      capturedOpts.onRunResultDone?.({} as never);
    });

    mountEmbedded();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    await act(async () => {});
    expect(posted).toHaveLength(1);
  });
});

/**
 * `/compact`（2026-08-20 对话页 UI/UX 改版）。
 *
 * 桌面端 registry 对这条命令是分两路的：claudecode 的 CLI 自己认 `/compact`，走
 * literal_text；codex / piagent 的 CLI **不认**，桌面端在 chat-panel 的 onSubmit 里
 * 拦下这段文本转成压缩 RPC。本站的对应物是 `runtime.run` 的 `compact` 参数
 * （daemon 的 handlers/runtime.go 把它直接透传给 runner，而 CapCompact 正是
 * codex 与 piagent 声明的）。不拦的话，菜单在这两个后端上摆出一条按下去只会当普通
 * 消息发出去、什么也不做的命令。
 */
describe("会话详情：/compact", () => {
  function mountBackend(backendType: string) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [{ ...summary, backendType }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "开场白" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  function runParams() {
    return fakeClient.request.mock.calls
      .filter((c) => c[0] === rpcMethods.runtimeRun)
      .at(-1)?.[1] as { compact?: boolean; userText?: string } | undefined;
  }

  it("codex：/compact 转成 runtime.run 的 compact 参数，不当普通消息发出去", async () => {
    mountBackend("codex");
    await screen.findByText("开场白");

    await sendInComposer("/compact");

    await vi.waitFor(() => expect(runParams()?.compact).toBe(true));
    // 压缩这一轮没有用户消息：把 `/compact` 也当正文送过去等于既压缩又多说一句。
    expect(runParams()?.userText).toBeFalsy();
  });

  it("claudecode：原样当正文送过去（CLI 自己认这条命令）", async () => {
    mountBackend("claudecode");
    await screen.findByText("开场白");

    await sendInComposer("/compact");

    await vi.waitFor(() => expect(runParams()?.userText).toBe("/compact"));
    expect(runParams()?.compact).toBeFalsy();
  });

  it("只拦**正好**是这条命令的那一行：带上下文的一句话照常当消息发", async () => {
    mountBackend("codex");
    await screen.findByText("开场白");

    await sendInComposer("/compact 之前先把结论记下来");

    await vi.waitFor(() =>
      expect(runParams()?.userText).toBe("/compact 之前先把结论记下来"),
    );
    expect(runParams()?.compact).toBeFalsy();
  });
});

/**
 * 尾部加载（规格 2026-08-21-transcript-tail-loading）。
 *
 * 打开一条对话取的是它**最后那一段**，钉在底部；往上滚才续读更早的。服务端的预算
 * （轮次 / 字节 / 行）与客户端的「够不够一屏」是两条**不同**的收尾条件：内容不满
 * 一屏时没有滚动条，滚动触发的续读永远不成立，更早的内容会变成够不着。
 */
describe("会话详情：转录只取尾巴，往上滚才续读", () => {
  /** jsdom 不做布局，这三个量恒为 0 —— 而「够不够一屏」正是拿它们判的。 */
  const geo = { scrollHeight: 0, clientHeight: 0 };
  const tops = new WeakMap<HTMLElement, number>();

  beforeEach(() => {
    geo.scrollHeight = 2000;
    geo.clientHeight = 500;
    const isScroller = (el: HTMLElement) =>
      el.dataset.testid === "session-detail-scroll";
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? geo.scrollHeight : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? geo.clientHeight : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        tops.set(this, v);
      },
    });
  });

  function scroller(): HTMLElement {
    return screen.getByTestId("session-detail-scroll");
  }

  /** 反向读的一页。 */
  function tailPage(
    frames: { seq: number; text: string }[],
    hasBefore = false,
  ) {
    return {
      frames: frames.map((f) => ({
        seq: f.seq,
        method: "runtime.event",
        params: {
          conversationId: "42",
          event: { kind: "text_delta", text: f.text },
        },
      })),
      cursor: frames.length ? frames[frames.length - 1].seq : 0,
      oldest_seq: frames.length ? frames[0].seq : 0,
      has_before: hasBefore,
    };
  }

  const mirrorRow = {
    total: 1,
    items: [{ peer_fingerprint: "fp-1", conversation_id: "42" }],
  };

  /** 装一个只答镜像的 api：pages 按请求顺序发。 */
  function serveMirror(pages: unknown[], asked: string[] = []) {
    let n = 0;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?")) return mirrorRow;
      if (path.startsWith("/v1/agent-sessions/transcript")) {
        asked.push(path);
        return pages[Math.min(n++, pages.length - 1)];
      }
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    return asked;
  }

  it("首屏走反向读，只发一次请求——不再从头翻到尾", async () => {
    const asked = serveMirror([
      tailPage(
        [
          { seq: 98, text: "倒数第二句" },
          { seq: 99, text: "最后一句" },
        ],
        true,
      ),
    ]);
    renderPage();

    expect(await screen.findByText(/最后一句/)).toBeTruthy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("direction=backward");
    expect(asked[0]).toContain("cursor=0");
    expect(asked[0]).toContain("conversation_id=42");
  });

  it("进去就停在底部", async () => {
    serveMirror([tailPage([{ seq: 99, text: "最后一句" }], true)]);
    renderPage();
    await screen.findByText(/最后一句/);

    await vi.waitFor(() => expect(scroller().scrollTop).toBe(geo.scrollHeight));
  });

  it("往上滚到距顶两屏：用 oldest_seq 再取一页，接在前面", async () => {
    const asked = serveMirror([
      tailPage([{ seq: 99, text: "最后一句" }], true),
      tailPage([{ seq: 50, text: "更早的那句" }], false),
    ]);
    renderPage();
    await screen.findByText(/最后一句/);
    await vi.waitFor(() => expect(scroller().scrollTop).toBe(2000));

    // 滚到距顶两屏以内（clientHeight=500 → 阈值 1000）。
    const el = scroller();
    fireEvent.wheel(el, { deltaY: -600 });
    el.scrollTop = 900;
    fireEvent.scroll(el);

    expect(await screen.findByText(/更早的那句/)).toBeTruthy();
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("cursor=99");
    expect(asked[1]).toContain("direction=backward");
    // 顺序：更早的在前。
    const body = screen.getByTestId("session-detail-transcript").textContent!;
    expect(body.indexOf("更早的那句")).toBeLessThan(body.indexOf("最后一句"));
  });

  it("往回读失败：说出来并给一条重试，不让人读成「翻到开头了」", async () => {
    let n = 0;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?")) return mirrorRow;
      if (path.startsWith("/v1/agent-sessions/transcript")) {
        n += 1;
        if (n === 1) return tailPage([{ seq: 99, text: "最后一句" }], true);
        if (n === 2) throw new Error("mirror unavailable");
        return tailPage([{ seq: 50, text: "更早的那句" }], false);
      }
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/最后一句/);
    const el = scroller();
    await vi.waitFor(() => expect(el.scrollTop).toBe(2000));

    fireEvent.wheel(el, { deltaY: -600 });
    el.scrollTop = 900;
    fireEvent.scroll(el);

    // 此前这一档只把 loading 关掉、不记失败：那行「正在读取更早的…」消失后什么都
    // 不出现，而更早的内容明明还在。用户会把这一片空白读成对话的开头。
    const failed = await screen.findByTestId("session-earlier-failed");
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/更早的那句/)).toBeTruthy();
    expect(screen.queryByTestId("session-earlier-failed")).toBeNull();
  });

  it("前插之后视口不跳：加了多少高度就往下挪多少", async () => {
    serveMirror([
      tailPage([{ seq: 99, text: "最后一句" }], true),
      tailPage([{ seq: 50, text: "更早的那句" }], false),
    ]);
    renderPage();
    await screen.findByText(/最后一句/);
    const el = scroller();
    await vi.waitFor(() => expect(el.scrollTop).toBe(2000));

    // 他自己往回翻 —— 转轮子这一下就是「离开底部」的证人（见 noteUserScroll）。
    fireEvent.wheel(el, { deltaY: -600 });
    el.scrollTop = 900;
    fireEvent.scroll(el);
    // 前插使内容长高 1200；补偿之后用户看的那一行应该还在原处。
    geo.scrollHeight = 3200;
    await screen.findByText(/更早的那句/);
    await vi.waitFor(() => expect(el.scrollTop).toBe(900 + 1200));
  });

  it("不满一屏而还有更早的：自动顶补，直到溢出视口", async () => {
    // 每来一页，内容长高 200；视口 500。所以第 3 页落地才溢出。
    geo.scrollHeight = 0;
    const asked: string[] = [];
    let n = 0;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?")) return mirrorRow;
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      if (path.startsWith("/v1/agent-sessions/transcript")) {
        asked.push(path);
        geo.scrollHeight += 200;
        return tailPage([{ seq: 99 - n * 10, text: `第 ${++n} 批` }], true);
      }
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    renderPage();

    await screen.findByText(/第 3 批/);
    // 溢出即停：不会一路把整条对话拉回来。
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(3);
    // 顶补期间一直钉在底部。
    expect(scroller().scrollTop).toBe(geo.scrollHeight);
  });

  it("补到封顶还是不满一屏：改出「加载更早的」，按一次续一页", async () => {
    geo.scrollHeight = 100; // 怎么补都填不满
    const asked = serveMirror([
      tailPage([{ seq: 99, text: "只有这些" }], true),
    ]);
    renderPage();
    await screen.findByText(/只有这些/);

    // 顶补是 5 轮**串行**的取数 → 渲染 → effect 接力，默认那 1000ms 的耐心在
    // 并行跑整套时不够用。放宽的是等待时间，不是断言。
    const btn = await screen.findByRole(
      "button",
      { name: /load earlier/i },
      { timeout: 5000 },
    );
    const before = asked.length;
    // 封顶了就不再自动补 —— 数不再涨。
    await new Promise((r) => setTimeout(r, 20));
    expect(asked.length).toBe(before);

    fireEvent.click(btn);
    await vi.waitFor(() => expect(asked.length).toBe(before + 1), {
      timeout: 5000,
    });
  });

  /**
   * 迟到的 scroll 事件（2026-09-03）。
   *
   * 联调机上实测：点进一条长对话，转录停在离底 717px 的地方，药丸当场浮出来写着
   * 「下面还有 2 轮」。时间线是——钉底把 scrollTop 推到当时的底（h=1281），46ms 后
   * 那一次**程序化滚动自己的 scroll 事件**才送到，而此刻行虚拟化已经把估算高度换成
   * 实测高度（h=1391）。位置式的判据据此认定「用户离开了底部」，从此再也不跟随。
   *
   * 跟随是**意图**不是位置：只有用户主动上滚才该解除它，内容长高把底部推远不算。
   * 桌面端把这条记在共享包的 nextAutoFollow 上（同一个回归 bug），这一端接同一份。
   */
  it("钉底之后内容才长高：迟到的 scroll 事件不解除跟随", async () => {
    serveMirror([tailPage([{ seq: 99, text: "最后一句" }], false)]);
    renderPage();
    await screen.findByText(/最后一句/);
    const el = scroller();
    await vi.waitFor(() => expect(el.scrollTop).toBe(2000));

    // 行虚拟化复测出真实行高，内容长高 600 —— 这条路不经过本视图的一次提交。
    geo.scrollHeight = 2600;
    // 我们自己那一次钉底的 scroll 事件此刻才送到：位置已经落后 100px。
    act(() => {
      fireEvent.scroll(el);
    });

    expect(screen.queryByTestId("transcript-jump-control")).toBeNull();

    // 还在跟随：下一帧到达时照样咬住底部。
    act(() => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "再来一句" },
        seq: 100,
      });
    });
    await screen.findByText(/再来一句/);
    await vi.waitFor(() => expect(el.scrollTop).toBe(2600));
  });

  /**
   * 复测长高之后没人再钉底（2026-09-03）。
   *
   * 上面那条只修好了「跟随意图别被误解除」，落地位置还差一半：钉底写完 scrollTop
   * 之后，行虚拟化才把估算行高换成实测行高，内容又长高几百像素——而这次重渲染发生在
   * **转录**里，本视图根本不提交，那条「每次提交都钉一遍」的 layout effect 一次都不
   * 跑。联调机上实测同一条对话有时停在离底 911px（同一份代码，另一次却是 0：谁先谁后
   * 全看这一帧的时序）。
   *
   * 所以跟随期间还要盯着内容的高度本身：它一长高就跟上去。
   */
  it("跟随期间内容被复测撑高：不等下一次提交就跟上去", async () => {
    const realRO = globalThis.ResizeObserver;
    const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
    class SpyResizeObserver implements ResizeObserver {
      private entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        this.entry.targets.length = 0;
      }
    }
    globalThis.ResizeObserver = SpyResizeObserver;
    try {
      serveMirror([tailPage([{ seq: 99, text: "最后一句" }], false)]);
      renderPage();
      await screen.findByText(/最后一句/);
      const el = scroller();
      await vi.waitFor(() => expect(el.scrollTop).toBe(2000));

      // 行虚拟化复测出真实行高，内容长高 600。没有任何一次本视图的提交。
      geo.scrollHeight = 2600;
      const content = screen.getByTestId(
        "session-detail-transcript",
      ).parentElement!;
      act(() => {
        for (const o of observers) {
          if (o.targets.some((t) => t.contains(content))) {
            o.cb([], {} as ResizeObserver);
          }
        }
      });

      expect(el.scrollTop).toBe(2600);
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });

  /**
   * 虚拟器自己把位置往回挪（2026-09-03）。
   *
   * 联调机上抓到的第二个动手的人：行虚拟化复测出「视口上方那些行」的真实高度后，
   * 会调自己的 scrollToFn 把 scrollTop 往回补（实测 1065 → 879，同一帧内容从 1777
   * 长到 2175），好让用户正在看的那一行不跟着漂。这一下与「用户上滚」在位置上完全
   * 同形，按方向判就又把跟随关掉了 —— 于是首屏停在离底 911px。
   *
   * 所以解除跟随的前提不止「位置往回走」，还得**这一下确实是用户的手**。
   */
  it("虚拟器复测时自己把位置往回挪：不算用户上滚", async () => {
    const realRO = globalThis.ResizeObserver;
    const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
    class SpyResizeObserver implements ResizeObserver {
      private entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        this.entry.targets.length = 0;
      }
    }
    globalThis.ResizeObserver = SpyResizeObserver;
    try {
      serveMirror([tailPage([{ seq: 99, text: "最后一句" }], false)]);
      renderPage();
      await screen.findByText(/最后一句/);
      const el = scroller();
      await vi.waitFor(() => expect(el.scrollTop).toBe(2000));

      // 虚拟器复测上方那些行，自己 scrollTo 把位置往回补，同时内容长高。
      geo.scrollHeight = 2600;
      act(() => {
        el.scrollTop = 1400;
        fireEvent.scroll(el);
      });

      expect(screen.queryByTestId("transcript-jump-control")).toBeNull();

      // 还在跟随：内容再长高就跟上去。
      const content = screen.getByTestId(
        "session-detail-transcript",
      ).parentElement!;
      act(() => {
        for (const o of observers) {
          if (o.targets.some((t) => t.contains(content))) {
            o.cb([], {} as ResizeObserver);
          }
        }
      });
      expect(el.scrollTop).toBe(2600);
    } finally {
      globalThis.ResizeObserver = realRO;
    }
  });

  it("没有更早的了：既不续读也不出按钮", async () => {
    geo.scrollHeight = 100;
    const asked = serveMirror([
      tailPage([{ seq: 1, text: "全部就这些" }], false),
    ]);
    renderPage();
    await screen.findByText(/全部就这些/);

    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /load earlier/i })).toBeNull();
    const el = scroller();
    el.scrollTop = 0;
    fireEvent.scroll(el);
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1);
  });

  /**
   * 账号里没有这一份（未保存的对话，机器轴上的大多数）：镜像如实回 0 帧，页面
   * **不能**因此显示成「还没有消息」——那是在说这条对话是空的，而事实是还没读到。
   */
  it("镜像空而机器在线：说正在从这台机器读，不摆一条空转录", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript")) return tailPage([]);
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    // 中继迟迟没接上：停在「正在读取」而不是「还没有消息」。
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return new Promise(() => ({}));
      throw new Error("unexpected: " + method);
    });
    renderPage();

    expect(
      await screen.findByTestId("session-reading-from-machine"),
    ).toBeTruthy();
    expect(screen.queryByText("No messages yet.")).toBeNull();
  });

  /** 补齐失败此前是 catch {} 静默吞掉的：页面停在空转录上，不出声。 */
  it("从机器补齐失败：如实说出来", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript")) return tailPage([]);
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockRejectedValue(new Error("boom"));
    renderPage();

    const alert = await screen.findByTestId("session-catchup-failed");
    /*
      文案必须落在 description 槽里。Alert 是两列 grid，第一列专留给图标、没有
      图标时宽度为 0（`grid-cols-[0_1fr]`），只有 AlertTitle / AlertDescription
      带 `col-start-2`。裸文本进的是第一列 —— 2026-08-30 在真实控制台上量到
      这句话被压成 28px 宽、457px 高的一竖行字。jsdom 算不出布局，所以这里断言
      的是「文案在哪个槽里」这个前提。
    */
    const description = alert.querySelector('[data-slot="alert-description"]');
    expect(description?.textContent).toContain("It may still be catching up.");
  });

  /**
   * 未保存的对话内容只有中继给得出。按 attach 交回的高水位反推游标，只补最后
   * 那一段——不再从游标 0 把整份 journal 拉回来。
   */
  it("镜像里没有：按 attach 的高水位反推游标，只拉尾巴", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript")) return tailPage([]);
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.attach.mockResolvedValue({
      conversationId: "42",
      lifecycleState: "idle",
      latestSeq: 5000,
    } as never);
    renderPage();

    await vi.waitFor(() =>
      expect(fakeClient.setCursor).toHaveBeenCalledWith(
        "42",
        5000 - RELAY_TAIL_FRAMES,
        undefined,
      ),
    );
  });
});

/**
 * 输入框那一带始终就位，档位只决定它是什么形态（规格 2026-08-21 决策 2 / 5）。
 *
 * 此前 `composerBand` 在 `showTranscript` 为假时整个是 `null`：连接中根本没有
 * 输入框，连上的那一刻它凭空长出一块 ~86px 把版面顶开。而机器离线时它是一个
 * 灰着的输入框 + 一段与横幅说同一件事的长文案。
 */
describe("会话详情：输入框那一带的三种形态", () => {
  /** 中继还在连：没有 client，relayState = connecting。 */
  function renderConnecting(devices = [deviceRow]) {
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null,
        relayState: "connecting",
        relayTicket: null,
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      throw new Error("unexpected: " + path);
    });
    return render(
      <MemoryRouter initialEntries={["/devices/1/sessions/42"]}>
        <ThemeProvider>
          <Routes>
            <Route
              path="/devices/:deviceId/sessions/:conversationId"
              element={<SessionDetail />}
            />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("连接中：输入框就在,只是停用——连上那一刻版面不会被顶开", async () => {
    renderConnecting();
    await vi.waitFor(() => {
      expect(screen.getByTestId("session-detail-send")).toBeTruthy();
    });
    expect(composerDisabled()).toBe(true);
    // 只读条是另一档的形态，这一档不该出现：连接中是会自愈的，不是只读。
    expect(screen.queryByTestId("session-compose-readonly")).toBeNull();
  });

  it("连接中：转录位置摆骨架,不再是一行「正在加载转录…」", async () => {
    renderConnecting();
    const skeleton = await screen.findByTestId("transcript-skeleton");
    // 骨架是纯装饰：芯片上的文字已经说了在连，它再念一遍只是噪音。
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText(/Loading transcript/i)).toBeNull();
    // 正在取内容这件事挂在滚动带上，读屏据此知道下面还会变。
    expect(
      screen.getByTestId("session-detail-scroll").getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("内容到齐之后骨架就撤走,也不再报 busy", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    renderPage();
    await screen.findByText(/重构登录页/);
    expect(screen.queryByTestId("transcript-skeleton")).toBeNull();
    expect(
      screen.getByTestId("session-detail-scroll").getAttribute("aria-busy"),
    ).not.toBe("true");
  });
});

/**
 * 发送失败改成转录流里的失败气泡（规格 2026-08-21 决策 7）。
 *
 * 此前三类失败折叠成同一句 `session.sendFailed`「…请重试」，挂在输入框下沿的
 * 11px 小红字里。而 `sessionView.ts` 自己的注释写明：transport 那一类**不能**
 * 重试，请求可能已经送达，重发会多出一条消息——文案在教用户做一件代码明说不
 * 安全的事。
 */
describe("会话详情：发送失败的气泡", () => {
  function mountFail(onRun: () => never) {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return onRun();
      throw new Error("unexpected: " + method);
    });
  }

  it("用户写的那段字留在气泡里,输入框腾空——可以接着说别的", async () => {
    mountFail(() => {
      throw new RelayError(-1, "relay: 连接已断开");
    });
    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer("改完帮我跑一下 relay 那组测试");

    const bubble = await screen.findByTestId("send-failure");
    expect(bubble.textContent).toContain("改完帮我跑一下 relay 那组测试");
    expect(composerText()).toBe("");
  });

  it("transport:主动作是「检查后重发」,并说清楚它可能已经送到了", async () => {
    mountFail(() => {
      throw new RelayError(-1, "relay: 连接已断开");
    });
    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer("继续");

    const bubble = await screen.findByTestId("send-failure");
    const primary = within(bubble).getByTestId("send-failure-retry");
    expect(primary.textContent).toBe(i18n.t("session.sendFailure.recheck"));
    // 「可能已经送达」这句必须在：它是不直接重发的理由。
    expect(bubble.textContent).toMatch(/may already have arrived/i);
  });

  it("rejected:主动作是「重发」——对端收到了并拒绝,重发是干净的空操作", async () => {
    mountFail(() => {
      throw new RelayError(-32603, "该后端不支持插话");
    });
    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer("继续");

    const bubble = await screen.findByTestId("send-failure");
    expect(within(bubble).getByTestId("send-failure-retry").textContent).toBe(
      i18n.t("session.sendFailure.resend"),
    );
    expect(bubble.textContent).not.toMatch(/may already have arrived/i);
  });

  it("丢弃:气泡走人,不留痕", async () => {
    mountFail(() => {
      throw new RelayError(-1, "relay: 连接已断开");
    });
    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer("不要了");

    const bubble = await screen.findByTestId("send-failure");
    await act(async () => {
      within(bubble).getByTestId("send-failure-discard").click();
    });
    expect(screen.queryByTestId("send-failure")).toBeNull();
  });

  it("重发成功:气泡撤走,而且真的又发了一次", async () => {
    let failNext = true;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) {
        if (failNext) {
          failNext = false;
          throw new RelayError(-32603, "该后端不支持插话");
        }
        return {};
      }
      throw new Error("unexpected: " + method);
    });
    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer("再来一次");

    const bubble = await screen.findByTestId("send-failure");
    await act(async () => {
      within(bubble).getByTestId("send-failure-retry").click();
    });
    await vi.waitFor(() => {
      expect(screen.queryByTestId("send-failure")).toBeNull();
    });
    const runs = fakeClient.request.mock.calls.filter(
      (c) => c[0] === rpcMethods.runtimeRun,
    );
    expect(runs.length).toBe(2);
    expect((runs[1][1] as { userText?: string }).userText).toBe("再来一次");
  });

  it("executionUnavailable 不进气泡:它已经有横幅了,不该同一件事说两遍", async () => {
    mountFail(() => {
      throw new RelayError(-32015, "execution unavailable");
    });
    renderPage();
    await screen.findByText(/重构登录页/);
    await sendInComposer("继续");

    expect(await screen.findByText(/New messages cannot be sent/)).toBeTruthy();
    expect(screen.queryByTestId("send-failure")).toBeNull();
  });
});

/**
 * 「这一轮还在跑」必须看得见。
 *
 * 数据早就到了浏览器手上（`runtime.autonomousTurn.started` / `runtime.run.done`
 * 两条通知），但它被存在一个 `useRef` 里 —— ref 刻意不参与渲染，所以哪怕把三点的
 * 开关接上也没有任何东西触发重渲染。用户这一侧的症状是：发完一条消息，对着一段
 * 不动的转录，分不清是在跑还是发丢了。
 *
 * 头部那颗状态点帮不上忙：它读的是 attach 那一刻取的 `session.list` 快照，此后
 * 永不刷新（组件自己的注释点名说了这件事）。
 */
describe("会话详情页:一轮在跑时的三点", () => {
  function wireRelay(extra?: (method: unknown) => unknown) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      const v = extra?.(method);
      if (v !== undefined) return v;
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "上一轮说完了" },
        seq: 1,
      });
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "done" },
        seq: 2,
      });
    });
  }

  const typing = () => screen.queryByRole("status", { name: "Generating" });

  it("刚打开一条空闲的会话:没有三点", async () => {
    wireRelay();
    renderPage();
    expect(await screen.findByText("上一轮说完了")).toBeTruthy();

    expect(typing()).toBeNull();
  });

  // 别的端（或后台任务）在这条会话上开了一轮:浏览器收到 autonomousTurn.started,
  // 三点就该出来 —— 这条会话此刻确实在跑。
  it("收到自主续轮开始:三点出现,收到轮次结束:三点消失", async () => {
    wireRelay();
    renderPage();
    expect(await screen.findByText("上一轮说完了")).toBeTruthy();

    act(() => capturedOpts.onAutonomousTurnStarted?.({} as never));
    await vi.waitFor(() => expect(typing()).toBeTruthy());

    act(() => capturedOpts.onRunResultDone?.({} as never));
    await vi.waitFor(() => expect(typing()).toBeNull());
  });

  it("自己发出一条消息:这一轮跑起来,三点出现", async () => {
    wireRelay((m) => (m === rpcMethods.runtimeRun ? {} : undefined));
    renderPage();
    expect(await screen.findByText("上一轮说完了")).toBeTruthy();

    await sendInComposer("再改一处");
    await vi.waitFor(() => expect(typing()).toBeTruthy());
    expect(screen.getByText("上一轮说完了").closest("article")).not.toContain(
      typing(),
    );
  });

  // 发出去之后**第一帧**是 daemon 把自己那条消息回声回来（agentred 的 run 日志里
  // 这一轮的 kinds 就是 map[UserMessage:1]）。它不是「对端开始回话了」，三点不能
  // 因为它落下去 —— 落下去之后这一轮再没有别的东西能把它点亮，用户对着自己刚发的
  // 那句话干等。
  it("自己那条消息回声回来:三点还在", async () => {
    wireRelay((m) => (m === rpcMethods.runtimeRun ? {} : undefined));
    renderPage();
    expect(await screen.findByText("上一轮说完了")).toBeTruthy();

    await sendInComposer("再改一处");
    await vi.waitFor(() => expect(typing()).toBeTruthy());

    act(() =>
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: {
          kind: "user_message",
          text: "再改一处",
          sourceDevice: "fp-web",
        },
        seq: 3,
      }),
    );

    await vi.waitFor(() => expect(screen.getByText("再改一处")).toBeTruthy());
    expect(typing()).toBeTruthy();
    // 也不许退回去挂在上一轮那条助手消息上：那等于说「上面那段还在写」。
    expect(screen.getByText("上一轮说完了").closest("article")).not.toContain(
      typing(),
    );
  });

  // 从「新对话」进来的那一条：整条转录里一条助手消息都还没有。回声一到，此前
  // 连挂三点的地方都没有了 —— 用户看到的就是自己发的那句话孤零零躺着。
  it("会话里第一句:回声回来之后三点还在", async () => {
    wireRelay((m) => (m === rpcMethods.runtimeRun ? {} : undefined));
    fakeClient.catchUp.mockImplementation(async () => {});
    renderPage();
    // 等摘要落地再发：`sendMessage` 拿不到 summary 会直接早退（那是它的合约），
    // 而空转录里没有别的东西能说明这一步过了。
    await screen.findByText(/重构登录页/);
    await awaitComposer();

    await sendInComposer("你好");
    await vi.waitFor(() => expect(typing()).toBeTruthy(), { timeout: 5000 });

    act(() =>
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "user_message", text: "你好", sourceDevice: "fp-web" },
        seq: 1,
      }),
    );

    await vi.waitFor(() => expect(screen.getByText("你好")).toBeTruthy());
    expect(typing()).toBeTruthy();
  });

  /*
    从「新对话」交接过来的那一条，以及轮次中途刷新页面。

    草稿页自己把 `runtime.run` 派发出去了（DraftSession.start），右栏随后换成真
    详情——挂载那一刻这一轮**已经在跑**，而转录里只有用户那句话，助手一个字都还
    没回。attach 那条路径只把 `turnActive` 接回来（按 session.list 的
    lifecycleState），占位没人接：`indicatorHostMessageId` 在末条是用户消息时返回
    null，于是整段等待里一个三点都没有。

    症状与「三点从来没接上」那一版一模一样：用户对着自己刚发的那句话干等，分不清
    是在跑还是发丢了——联调机上实测干等 88 秒。
  */
  it("接手一条已经在跑、助手还没开口的会话:三点在", async () => {
    wireRelay();
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [{ ...summary, lifecycleState: SessionLifecycleRunning }],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: {
          kind: "user_message",
          text: "看看目录",
          sourceDevice: "fp-web",
        },
        seq: 1,
      });
    });
    renderPage();
    expect(await screen.findByText("看看目录")).toBeTruthy();

    await vi.waitFor(() => expect(typing()).toBeTruthy(), { timeout: 2000 });
  });

  // 助手真开口之后三点才该跟着正文走 —— 这一条守住上面两条不是靠「永不熄灭」
  // 蒙对的。
  it("助手开口:三点跟到助手那条上,轮次结束后熄灭", async () => {
    wireRelay((m) => (m === rpcMethods.runtimeRun ? {} : undefined));
    fakeClient.catchUp.mockImplementation(async () => {});
    renderPage();
    await screen.findByText(/重构登录页/);
    await awaitComposer();

    await sendInComposer("你好");
    await vi.waitFor(() => expect(typing()).toBeTruthy(), { timeout: 5000 });
    act(() =>
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "user_message", text: "你好", sourceDevice: "fp-web" },
        seq: 1,
      }),
    );
    act(() =>
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "在的" },
        seq: 2,
      }),
    );

    await vi.waitFor(() => {
      expect(screen.getByText("在的").closest("article")).toContain(typing());
    });

    act(() => capturedOpts.onRunResultDone?.({} as never));
    await vi.waitFor(() => expect(typing()).toBeNull());
  });

  /*
    另一个窗口发的那条消息。同一个账号的两条连接都上过这条会话，daemon 按会话把
    这一轮的事件扇给它们两个（connRegistry 的订阅者集合），所以这一屏收得到回声、
    也收得到助手的正文——它只是**没发过**这一轮。

    而「有一轮跑起来了」这件事,这一屏此前没有任何来路:`turnActive` 转真的三条路
    （自己发送 / `autonomousTurn.started` / attach 那一刻的清单快照）一条也不成立
    —— 起始通知只在**自主续轮**时发（handlers/runtime.go 的 forwardAutonomousTurn），
    别人一次普通的 `runtime.run` 什么都不发,而快照是打开这一屏那一刻取的。

    于是旁观的那个窗口从按下发送到回复到齐全程一动不动:自己那句话躺在那里,没有
    三点、没有任何「在跑」的表示,回复也就那么突然冒出来。

    说得出这件事的东西一直都在:一轮的第一帧永远是 daemon 把那条用户消息回声回来
    （上面「自己那条消息回声回来」那条守的是同一件事的另一半）。
  */
  it("别的窗口开的一轮:回声一到,这一屏也出三点", async () => {
    wireRelay();
    renderPage();
    expect(await screen.findByText("上一轮说完了")).toBeTruthy();
    expect(typing()).toBeNull();

    act(() =>
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: {
          kind: "user_message",
          text: "换成 zinc",
          sourceDevice: "fp-other",
        },
        seq: 3,
      }),
    );

    await vi.waitFor(() => expect(screen.getByText("换成 zinc")).toBeTruthy());
    await vi.waitFor(() => expect(typing()).toBeTruthy());
  });

  // 旁观窗口的三点同样要收得掉。终态帧走的是同一条扇出，这一屏收得到——不然点亮
  // 之后就再也熄不了，一条早就跑完的会话永远转着三点。
  it("别的窗口开的一轮:这一屏的三点跟到助手那条上,轮次结束后熄灭", async () => {
    wireRelay();
    renderPage();
    expect(await screen.findByText("上一轮说完了")).toBeTruthy();

    act(() =>
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: {
          kind: "user_message",
          text: "换成 zinc",
          sourceDevice: "fp-other",
        },
        seq: 3,
      }),
    );
    act(() =>
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "好的" },
        seq: 4,
      }),
    );

    await vi.waitFor(() => {
      expect(screen.getByText("好的").closest("article")).toContain(typing());
    });

    act(() => capturedOpts.onRunResultDone?.({} as never));
    await vi.waitFor(() => expect(typing()).toBeNull());
  });
});

/**
 * 「lost」这一档的唯一出路。
 *
 * 横幅自己说的是「连接已断开，已经不再自动重试」——一句终局的话。而 `onReconnect`
 * 此前全仓只有测试传过：横幅那颗「重新连接」按钮在真实页面上从来没渲染出来过。
 * 于是用户读到「不再重试」，却一个重试的手段都没有，唯一出路是刷新整页，而界面
 * 没告诉他这一点。
 */
describe("会话详情页:连接彻底断掉之后的出路", () => {
  function renderLost() {
    const reconnect = vi.fn();
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: null as never,
        relayState: "disconnected",
        relayTicket: null,
        relayTicketError: null,
        reconnect,
      };
    });
    mockedApi.mockImplementation(async (path) => {
      // 机器在线 —— 「连过又放弃了」才成立；机器离线是另一档横幅。
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    render(
      <MemoryRouter initialEntries={["/devices/1/sessions/42"]}>
        <ThemeProvider>
          <Routes>
            <Route
              path="/devices/:deviceId/sessions/:conversationId"
              element={<SessionDetail />}
            />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>,
    );
    return reconnect;
  }

  it("连接彻底断掉:横幅上有「重新连接」,点它真的重连", async () => {
    const reconnect = renderLost();

    const button = await screen.findByRole("button", { name: "Reconnect" });
    fireEvent.click(button);

    expect(reconnect).toHaveBeenCalledOnce();
  });
});

/**
 * 重连期间照常打字，发送即排队，连上自动发出（规格 2026-08-21 决策 6）。
 *
 * 此前 `reconnecting` 下输入框是禁用的。可重连通常几秒就回来——禁用换来的只是
 * 让人干等着，而这段时间里想说的那句话得自己记住。
 *
 * 排队的那一条**看得见**：一条静默的队列，连上时突然发出、或者永远没发出去，
 * 两种都比说清楚更坏。
 */
describe("会话详情：重连期间的发送", () => {
  let relayState: RelayState = "reconnecting";
  let rerenderTree: (() => void) | null = null;

  function mountReconnecting() {
    relayState = "reconnecting";
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState,
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
    // 每次都新造一个元素：把**同一个**元素引用交回给 rerender，React 会走
    // 「引用没变」的快路直接跳过，这棵树根本不会重渲染。
    const tree = () => (
      <MemoryRouter initialEntries={["/devices/1/sessions/42"]}>
        <ThemeProvider>
          <Routes>
            <Route
              path="/devices/:deviceId/sessions/:conversationId"
              element={<SessionDetail />}
            />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>
    );
    const view = render(tree());
    rerenderTree = () => view.rerender(tree());
    return view;
  }

  /**
   * 把中继切到另一档。`useRelay` 是个 mock，它不会自己通知谁——所以要手动把这棵树
   * 重渲染一次，让组件重新读到新的 relayState（真实 hook 里这一步由 setState 完成）。
   */
  async function moveRelayTo(next: RelayState) {
    relayState = next;
    await act(async () => {
      rerenderTree?.();
    });
  }

  function runCalls() {
    return fakeClient.request.mock.calls.filter(
      (c) => c[0] === rpcMethods.runtimeRun,
    );
  }

  it("重连中输入框不禁用——它几秒就回来,禁用换来的只是让人干等", async () => {
    mountReconnecting();
    await screen.findByTestId("session-detail-send");
    expect(composerDisabled()).toBe(false);
  });

  it("重连中发送:不往断了的连接上扔,排一条看得见的队,输入框腾空", async () => {
    mountReconnecting();
    await screen.findByTestId("session-detail-send");

    await sendInComposer("改完帮我跑一下 relay 那组测试");

    const queued = await screen.findByTestId("send-pending");
    expect(queued.textContent).toContain("改完帮我跑一下 relay 那组测试");
    expect(composerText()).toBe("");
    // 连接断着，一次 RPC 都不该发出去。
    expect(runCalls().length).toBe(0);
  });

  it("连上之后自动发出,队列里那条随之撤走", async () => {
    mountReconnecting();
    await screen.findByTestId("session-detail-send");
    await sendInComposer("继续那件事");
    await screen.findByTestId("send-pending");

    await moveRelayTo("connected");

    await vi.waitFor(() => {
      expect(runCalls().length).toBe(1);
    });
    expect((runCalls()[0][1] as { userText?: string }).userText).toBe(
      "继续那件事",
    );
    await vi.waitFor(() => {
      expect(screen.queryByTestId("send-pending")).toBeNull();
    });
  });

  it("连接彻底断了:排着的那条变成失败气泡,而且说的是「从没送到」", async () => {
    mountReconnecting();
    await screen.findByTestId("session-detail-send");
    await sendInComposer("这条要保住");
    await screen.findByTestId("send-pending");

    await moveRelayTo("disconnected");

    const bubble = await screen.findByTestId("send-failure");
    // 它从来没走到对端，所以重发是安全的——不是 transport 那种「可能已经送达」。
    expect(bubble.getAttribute("data-failure-kind")).toBe("notSent");
    expect(bubble.textContent).toContain("这条要保住");
    expect(within(bubble).getByTestId("send-failure-retry").textContent).toBe(
      i18n.t("session.sendFailure.resend"),
    );
    expect(bubble.textContent).not.toMatch(/may already have arrived/i);
  });

  it("排着的那条可以撤销:撤了就什么都不发", async () => {
    mountReconnecting();
    await screen.findByTestId("session-detail-send");
    await sendInComposer("算了");
    const queued = await screen.findByTestId("send-pending");

    await act(async () => {
      within(queued).getByTestId("send-pending-cancel").click();
    });
    expect(screen.queryByTestId("send-pending")).toBeNull();

    await moveRelayTo("connected");
    await act(async () => {});
    expect(runCalls().length).toBe(0);
  });
});

/**
 * 2026-08-23 对话页外壳收口的跨端对齐（规格
 * `agentre/docs/specs/2026-08-23-chat-surface-alignment.md`）。
 *
 * 桌面端先落，共同的呈现件沉进 `@agentre-hub/agentre-ui`，这一端钉住那一版再切。
 * 这一端本来就已经满足的（停止按需渲染、`<h2>` 标题、骨架、`Alert` 失败态）不回退，
 * 这里补的是另外三样：身份行恒高、meta 行窄档分档降级、输入带边界跟随贴底。
 */
describe("会话详情：与桌面端对齐的外壳", () => {
  function stubAligned() {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "很长的一段转录" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
  }

  function renderAligned() {
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("Given 标题长短不定, When 渲染, Then 身份行的高度是写死的两行高，不再随标题伸缩", async () => {
    stubAligned();
    renderAligned();

    await screen.findByText("很长的一段转录");
    const identity = screen.getByTestId("session-detail-identity");
    expect(identity.className).toMatch(/(^|\s)h-\[68px\](\s|$)/);
    expect(identity.className).not.toMatch(/min-h-/);
  });

  it("Given 面板变窄, When 渲染, Then meta 行不折行，机器那一段先被收起", async () => {
    stubAligned();
    renderAligned();

    await screen.findByText("很长的一段转录");
    const meta = screen.getByTestId("session-detail-meta");
    expect(meta.className).not.toMatch(/flex-wrap/);
    expect(screen.getByTestId("session-detail-meta-machine").className).toMatch(
      /@max-\[\d+px\]\/header:hidden/,
    );
  });

  it("Given 转录贴底, When 渲染, Then 输入带没有分隔线", async () => {
    stubAligned();
    renderAligned();

    await screen.findByText("很长的一段转录");
    const band = screen.getByTestId("session-composer-band");
    expect(band.getAttribute("data-scrolled")).toBe("false");
    expect(band.className).not.toMatch(/border-t/);
  });

  it("Given 转录贴底, When 渲染, Then 末条消息与输入框之间的留白不再由三段各付一遍", async () => {
    stubAligned();
    renderAligned();

    await screen.findByText("很长的一段转录");
    // 末行自带 pb-7 的消息间距；滚动带再叠 pb-4、输入带再叠 pt-3，贴底时攒出
    // 一大块空档。底部留白交还给内容自己的间距，两侧各只留落脚的一点。
    const scroll = screen.getByTestId("session-detail-scroll");
    expect(scroll.className).toMatch(/(^|\s)pt-4(\s|$)/);
    expect(scroll.className).toMatch(/(^|\s)pb-2(\s|$)/);

    const band = screen.getByTestId("session-composer-band");
    expect(band.className).toMatch(/(^|\s)pt-2(\s|$)/);
  });

  it("Given 用户上滚离开底部, When 渲染, Then 输入带出现分隔线与一段不接收指针事件的向上渐隐", async () => {
    stubAligned();
    renderAligned();

    await screen.findByText("很长的一段转录");
    const scroll = screen.getByTestId("session-detail-scroll");
    Object.defineProperty(scroll, "clientHeight", {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(scroll, "scrollHeight", {
      configurable: true,
      get: () => 4_000,
    });
    act(() => {
      fireEvent.wheel(scroll, { deltaY: -600 });
      scroll.scrollTop = 1_000;
      fireEvent.scroll(scroll);
    });

    const band = screen.getByTestId("session-composer-band");
    expect(band.getAttribute("data-scrolled")).toBe("true");
    expect(band.className).toMatch(/(^|\s)border-t(\s|$)/);
    const fade = screen.getByTestId("session-composer-band-fade");
    expect(fade.className).toMatch(/(^|\s)pointer-events-none(\s|$)/);
    expect(fade.getAttribute("aria-hidden")).toBe("true");
  });
});

/**
 * 「回到底部」（2026-08-24）。
 *
 * 这一端此前**根本没有**这枚控件：长对话往回翻之后只能自己拖回去。桌面端那枚
 * 已经收进共享包并统一成药丸一种形状，这里接的是同一个实现。
 */
describe("会话详情：回到底部", () => {
  function stubJump() {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "很长的一段转录" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
  }

  function scrollerWithHeights(): HTMLElement {
    const el = screen.getByTestId("session-detail-scroll");
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => 4_000,
    });
    return el;
  }

  it("Given 转录贴底, When 渲染, Then 不摆这枚控件", async () => {
    stubJump();
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await screen.findByText("很长的一段转录");
    expect(screen.queryByTestId("transcript-jump-control")).toBeNull();
  });

  it("Given 用户往回翻, When 渲染, Then 药丸浮出来并写着「回到底部」；点它滚回底部、控件收走", async () => {
    stubJump();
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await screen.findByText("很长的一段转录");
    const scroll = scrollerWithHeights();
    act(() => {
      fireEvent.wheel(scroll, { deltaY: -600 });
      scroll.scrollTop = 1_000;
      fireEvent.scroll(scroll);
    });

    const control = screen.getByTestId("transcript-jump-control");
    expect(control.textContent).toContain("Back to bottom");

    act(() => {
      fireEvent.click(control);
    });

    expect(scroll.scrollTop).toBe(4_000);
    expect(screen.queryByTestId("transcript-jump-control")).toBeNull();
  });

  /**
   * 「下面还有 N 轮」（2026-08-26）。药丸此前只写「回到底部」，说不出用户落后了
   * 多少。判轮与视口下沿定位都在共享包里（桌面端同一份），这一端要做的只有两件：
   * 给消息行挂 data-message-id、把算出来的轮数交给药丸。
   */
  function stubTurns() {
    stubJump();
    fakeClient.catchUp.mockImplementation(async () => {
      // 三轮：每轮一条用户消息 + 一条助手回复。
      const frames = [
        { kind: "user_message", text: "第一问" },
        { kind: "text_delta", text: "第一答" },
        { kind: "user_message", text: "第二问" },
        { kind: "text_delta", text: "第二答" },
        { kind: "user_message", text: "第三问" },
        { kind: "text_delta", text: "第三答" },
      ];
      frames.forEach((event, i) => {
        capturedOpts.onEvent?.({ conversationId: "42", event, seq: i + 1 });
      });
    });
  }

  /** jsdom 没有布局：给滚动容器与消息行钉上几何，让下沿落在第 visibleRows 行之后。 */
  function layoutRows(scroll: HTMLElement, visibleRows: number) {
    scroll.getBoundingClientRect = () =>
      ({ bottom: visibleRows * 100 }) as DOMRect;
    const rows = Array.from(
      scroll.querySelectorAll<HTMLElement>("[data-message-id]"),
    );
    rows.forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: i * 100 }) as DOMRect;
    });
    return rows.length;
  }

  it("Given 用户往回翻、视口下沿之后还压着两轮, When 药丸浮出, Then 它写出轮数", async () => {
    stubTurns();
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await screen.findByText("第三答");
    const scroll = scrollerWithHeights();
    // 下沿落在第 2 行之后 —— 那是第一轮的助手回复，它之后还开了第二、第三两轮。
    expect(layoutRows(scroll, 2)).toBe(6);
    act(() => {
      fireEvent.wheel(scroll, { deltaY: -600 });
      scroll.scrollTop = 1_000;
      fireEvent.scroll(scroll);
    });

    expect(screen.getByTestId("transcript-jump-control").textContent).toContain(
      "2 turns below",
    );
  });

  it("Given 用户只上滚了一点、还在最后一轮里, When 药丸浮出, Then 退回「回到底部」", async () => {
    stubTurns();
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await screen.findByText("第三答");
    const scroll = scrollerWithHeights();
    // 下沿落在第 5 行之后 —— 第三轮的用户消息，其后只有本轮的助手回复。
    layoutRows(scroll, 5);
    act(() => {
      fireEvent.wheel(scroll, { deltaY: -600 });
      scroll.scrollTop = 1_000;
      fireEvent.scroll(scroll);
    });

    expect(screen.getByTestId("transcript-jump-control").textContent).toContain(
      "Back to bottom",
    );
  });
});
/**
 * 发出去之后回到底部（2026-09-02）。
 *
 * 钉底此前只挂在 `events` 上 —— 那是**对端说过的话**。而「按下发送」这一下改变的
 * 是别的东西：往回翻着看的人此刻明确表示要继续这条对话（他自己的话就在下面），
 * 排队 / 失败那两种气泡也挂在转录之外、一条事件都不产生。两处都会把刚发生的事
 * 留在折叠线以下，界面看起来像是「没反应」。
 */
describe("会话详情：发出去之后回到底部", () => {
  /** 连上的那一档：转录读得到，run 由用例自己决定成不成。 */
  function stubSend(run: () => unknown = () => ({})) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return run();
      throw new Error("unexpected: " + method);
    });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "很长的一段转录" },
        seq: 1,
      });
    });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });
  }

  function mount() {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  /**
   * jsdom 不做布局，滚动容器的三个量恒为 0。这里钉上几何：高度按 `grow()` 说的
   * 「此刻内容有多高」算，用例据此模拟「气泡挂上来之后内容长高了」。
   */
  function scrollerWithHeights(grow: () => number = () => 0): HTMLElement {
    const el = screen.getByTestId("session-detail-scroll");
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => 4_000 + grow(),
    });
    return el;
  }

  it("Given 用户往回翻着看, When 他发出一条消息, Then 视口滚回底部、药丸收走", async () => {
    stubSend();
    mount();

    await screen.findByText("很长的一段转录");
    const scroll = scrollerWithHeights();
    act(() => {
      fireEvent.wheel(scroll, { deltaY: -600 });
      scroll.scrollTop = 1_000;
      fireEvent.scroll(scroll);
    });
    expect(screen.getByTestId("transcript-jump-control")).toBeTruthy();

    await sendInComposer("再跑一遍 relay 那组测试");

    await vi.waitFor(() => expect(scroll.scrollTop).toBe(4_000));
    expect(screen.queryByTestId("transcript-jump-control")).toBeNull();
  });

  it("Given 贴着底、这一条没发出去, When 失败气泡挂到转录下面, Then 视口跟着它长高", async () => {
    stubSend(() => {
      throw new Error("boom");
    });
    mount();

    await screen.findByText("很长的一段转录");
    // 气泡挂上来之后内容长高 600 —— 它在转录**之外**，一条事件都不产生。
    const scroll = scrollerWithHeights(() =>
      document.querySelector('[data-testid="send-failure"]') ? 600 : 0,
    );
    act(() => {
      scroll.scrollTop = 4_000;
      fireEvent.scroll(scroll);
    });

    await sendInComposer("这条会失败");

    await screen.findByTestId("send-failure");
    await vi.waitFor(() => expect(scroll.scrollTop).toBe(4_600));
  });
});

/**
 * 头部的「更多」菜单，以及它现在唯一一条真项目：复制会话号。
 *
 * 这颗按钮此前是**刻意不摆**的 —— 组件抬头那段注释点名说过，画板里的「分享链接 /
 * more」在协议上没有对应物，摆一个点开全是灰项的菜单不如不摆。复制会话号把这条
 * 理由破了：号就在这一屏手里，不需要任何协议支持，而排查时（对 daemon 日志、查
 * `agent_sessions`、给人报问题）第一件要的东西就是它。
 *
 * 形态跟桌面端 `chat-panel-header.tsx` 同一套：**点击**打开的下拉，不是右键菜单
 * ——右键那份在左栏的行上（`SessionIndex` 的 RowContextMenu），而右栏正读着这条
 * 对话时没有「哪一行」可点。
 */
describe("会话详情：头部的更多菜单", () => {
  function stubIdle() {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
  }

  /** Radix 的下拉开在 pointerdown 上，不是 click。 */
  function openMenu() {
    const trigger = screen.getByTestId("session-detail-menu-trigger");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    if (!screen.queryByRole("menu")) fireEvent.click(trigger);
  }

  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it("复制会话号:把号原样交给剪贴板", async () => {
    stubIdle();
    const writeText = stubClipboard();
    renderPage();
    await screen.findByText(/重构登录页/);

    openMenu();
    fireEvent.click(await screen.findByText("Copy session ID"));

    // 交出去的是 wire 上那个号本身，不带 `#` —— 复制出来是要拿去搜日志、
    // 查 `agent_sessions` 的，多一个字符就得手动删。
    expect(writeText).toHaveBeenCalledWith("42");
  });

  // 复制完菜单就关了，内联的「已复制」没有地方留 —— 回执只能是 toast。
  // 断言打在 `toast.success` 上而不是渲染出来的字：Toaster 挂在 App 上，这一屏
  // 没有它（与本文件里决策提交失败那条同一套办法）。
  it("复制成功给回执", async () => {
    stubIdle();
    stubClipboard();
    // 同一个文件里前面的用例也 spy 过它，而 spy 不会自己清零。
    const succeeded = vi.spyOn(toast, "success").mockClear();
    renderPage();
    await screen.findByText(/重构登录页/);

    openMenu();
    fireEvent.click(await screen.findByText("Copy session ID"));

    await vi.waitFor(() =>
      expect(succeeded.mock.calls[0]?.[0]).toBe("Session ID copied"),
    );
  });

  /*
    复制不成的时候不许说「已复制」。

    非安全上下文（本站就是 http 部署的常客）没有 Clipboard API，共享包的
    `copyTextToClipboard` 会退回 `execCommand`；jsdom 两样都没有，于是这里落到
    的正是「彻底复制不成」那一档。谎报成功比复制失败更糟：用户会带着一个空剪贴板
    去粘贴，而屏幕刚说过复制好了。
  */
  it("复制不成时不谎报成功", async () => {
    stubIdle();
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => false),
      configurable: true,
    });
    const succeeded = vi.spyOn(toast, "success").mockClear();
    const failed = vi.spyOn(toast, "error").mockClear();
    renderPage();
    await screen.findByText(/重构登录页/);

    openMenu();
    fireEvent.click(await screen.findByText("Copy session ID"));

    await vi.waitFor(() =>
      expect(failed.mock.calls[0]?.[0]).toBe("Could not copy the session ID"),
    );
    expect(succeeded).not.toHaveBeenCalled();
  });
});

/**
 * 会话级思考力度控件（规格 2026-09-01「跨宿主：agentre-server 宿主」）。
 *
 * 网页端渲染的是共享包**同一颗** `ReasoningEffortPicker`（决策 8），宿主只接三样：
 * 后端支不支持（执行端自报的能力位，不按 backendType 猜）、选定后往两台机器写、
 * 以及只写成一台时如实说明。
 */
describe("会话详情页 · 会话级思考力度", () => {
  /**
   * @param capable 执行端报不报 reasoning_effort 能力位
   * @param origin 会话摘要上的发起端指纹（与承载机 fp-1 不同时才有第二台要写）
   */
  function mockEffort(opts: {
    capable: boolean;
    origin?: string;
    sessionEffort?: string;
    backendEffort?: string;
    setEffort?: () => unknown;
  }) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents")
        return {
          agents: [
            {
              sync_id: "ag-1",
              name: "Claude",
              exec_targets: [{ backend_sync_id: "backend-1", current: true }],
            },
          ],
        };
      if (path === "/v1/engine/backends")
        return {
          backends: [
            {
              sync_id: "backend-1",
              provider_key: "anthropic",
              model_key: "sonnet",
              default_permission_mode: "default",
              reasoning_effort: opts.backendEffort ?? "",
            },
          ],
        };
      if (path === "/v1/engine/providers") return { providers: [] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [
            {
              ...summary,
              peerFingerprint: opts.origin,
              reasoningEffort: opts.sessionEffort ?? "",
            },
            // 同机器上的另一条会话：换会话那条用例要它，且它**没有**钉力度。
            { ...summary, conversationId: "43", reasoningEffort: "" },
          ],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeCapabilities)
        return {
          capabilities: opts.capable
            ? [{ name: "reasoning_effort", enabled: true }]
            : [{ name: "reasoning_effort", enabled: false }],
          permissionMode: { allowedModes: [] },
        };
      if (method === rpcMethods.setSessionReasoningEffort)
        return opts.setEffort ? opts.setEffort() : {};
      throw new Error("unexpected: " + method);
    });
  }

  async function pickEffort(level: string) {
    fireEvent.click(
      await screen.findByRole("button", { name: /Reasoning effort/ }),
    );
    fireEvent.click(screen.getByRole("option", { name: level }));
  }

  it("后端声明该能力时控件摆在底栏右侧、提交键之前", async () => {
    mockEffort({ capable: true, backendEffort: "high" });

    renderPage();

    const pill = await screen.findByTestId("composer-reasoning-effort");
    // 脸上写的是**有效**档位：会话没钉时就是后端配置的那一档。
    expect(pill.textContent).toContain("high");
    const gap = document.querySelector('[data-slot="composer-gap"]')!;
    const send = screen.getByTestId("session-detail-send");
    // trailing 侧 = 弹性空档之后、提交键之前。
    expect(
      gap.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      pill.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("后端没有这个能力（openclaw）时整颗控件不渲染", async () => {
    mockEffort({ capable: false });

    renderPage();

    await screen.findByTestId("session-detail-send");
    await vi.waitFor(() =>
      expect(
        fakeClient.request.mock.calls.some(
          ([m]) => m === rpcMethods.runtimeCapabilities,
        ),
      ).toBe(true),
    );
    expect(screen.queryByTestId("composer-reasoning-effort")).toBeNull();
  });

  it("选定一档时承载端与发起端各写一次", async () => {
    mockEffort({ capable: true, origin: "fp-origin" });

    renderPage();
    await pickEffort("high");

    await vi.waitFor(() => {
      const call = fakeClient.request.mock.calls.find(
        ([m]) => m === rpcMethods.setSessionReasoningEffort,
      );
      expect(call?.[1]).toMatchObject({
        conversationId: "42",
        reasoningEffort: "high",
        peerFingerprint: "fp-origin",
      });
    });
    expect(mockWriteEffortToOrigin).toHaveBeenCalledWith("fp-origin", {
      conversationId: "42",
      reasoningEffort: "high",
    });
  });

  it("只写成一台时如实说明，且不回滚已经生效的那一次", async () => {
    mockEffort({ capable: true, origin: "fp-origin" });
    mockWriteEffortToOrigin.mockRejectedValueOnce(new Error("origin offline"));

    renderPage();
    await pickEffort("high");

    const note = await screen.findByTestId("composer-effort-note");
    expect(note.textContent).toContain("has not caught up");
    // 承载端那一次真的生效了，脸上就得留着它。
    expect(
      screen.getByRole("button", { name: /Reasoning effort/ }).textContent,
    ).toContain("high");
  });

  /*
    右栏换会话是**同实例换 props**（桌面 Chat 点行 A 再点行 B）：会话级状态不随
    (did, sid) 重置的话，B 的控件会摆着 A 刚选的那一档 —— 一句 B 这条会话上不存在
    的话。
  */
  it("换到另一条会话时不带着上一条选的档位", async () => {
    mockEffort({ capable: true });
    mockUseRelay.mockImplementation((_fp, opts) => {
      capturedOpts = opts ?? {};
      return {
        client: fakeClient as never,
        relayState: "connected",
        relayTicket: {
          clientId: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        reconnect: vi.fn(),
      };
    });

    const { rerender } = render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await pickEffort("high");
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Reasoning effort/ }).textContent,
      ).toContain("high"),
    );

    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="43" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Reasoning effort/ }).textContent,
      ).toContain("Default"),
    );
  });

  it("两台都写不进去时回滚控件并如实说明", async () => {
    mockEffort({
      capable: true,
      origin: "fp-origin",
      setEffort: () => {
        throw new Error("machine says no");
      },
    });
    mockWriteEffortToOrigin.mockRejectedValueOnce(new Error("origin offline"));

    renderPage();
    await pickEffort("high");

    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Reasoning effort/ }).textContent,
      ).toContain("Default"),
    );
    // 两台都没写成不是「另一台没跟上」那种如实说明，是控件自己的失败：走弹层
    // 底部的错误行（共享控件的 errorText），不是旁边那条 sibling note。
    expect(screen.queryByTestId("composer-effort-note")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Reasoning effort/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Reasoning effort was not changed");
  });
});

// ── 头部状态：这一轮在不在跑，认的是实时轮次不是装载快照 ─────────────────────
//
// `summary` 只在 attach 那一刻由 session.list 取一次，此后永不刷新（同一条事实在
// 上面选路那一段也写着）。头部此前把状态点、状态文字与「停止」按钮全挂在它上面：
// 打开会话时是 idle，之后自己发多少条消息，点都是灰的、「停止」也不出现 —— 而这
// 一屏明明知道这一轮在跑（`turnActive` 正是 run/steer 选路和转录三点用的那一个）。
describe("会话详情页:头部状态跟着实时轮次走", () => {
  function wireIdleSession() {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });
  }

  /** 头部那一段的文字（Agent 名解不出来时它就是状态文字）。 */
  const statusText = () =>
    screen.getByTestId("session-detail-status").textContent;
  /** 状态点的颜色类（`bg-status-*`）—— 状态不只靠文字，点也得对。 */
  const statusDotClass = () =>
    screen
      .getByTestId("session-detail-status")
      .querySelector("[aria-label$='status']")?.className ?? "";

  it("Given 打开时是空闲 When 自己发一条 Then 头部变 Running 并摆出停止", async () => {
    wireIdleSession();
    renderPage();
    await screen.findByText(/重构登录页/);
    expect(statusText()).toContain("Idle");
    expect(screen.queryByTestId("session-detail-stop")).toBeNull();

    await vi.waitFor(() => expect(composerDisabled()).toBe(false));
    await sendInComposer("开始重构");

    await vi.waitFor(() => expect(statusText()).toContain("Running"));
    expect(statusDotClass()).toContain("bg-status-running");
    expect(screen.getByTestId("session-detail-stop")).toBeTruthy();
  });

  it("Given 这一轮跑起来了 When 收到终态帧 Then 头部退回 Idle 并收起停止", async () => {
    wireIdleSession();
    renderPage();
    await screen.findByText(/重构登录页/);
    await vi.waitFor(() => expect(composerDisabled()).toBe(false));
    await sendInComposer("开始重构");
    await vi.waitFor(() => expect(statusText()).toContain("Running"));

    act(() => capturedOpts.onRunResultDone?.({} as never));

    await vi.waitFor(() => expect(statusText()).toContain("Idle"));
    expect(screen.queryByTestId("session-detail-stop")).toBeNull();
  });

  // 别的端开的一轮同样算数：`autonomousTurn.started` 是这一屏唯一能知道「不是我
  // 开的这一轮正在跑」的信号，快照那时早就过期了。
  it("Given 别的端开了一轮 When 收到自主续轮开始 Then 头部也变 Running", async () => {
    wireIdleSession();
    renderPage();
    await screen.findByText(/重构登录页/);
    expect(statusText()).toContain("Idle");

    act(() => capturedOpts.onAutonomousTurnStarted?.({} as never));

    await vi.waitFor(() => expect(statusText()).toContain("Running"));
    expect(screen.getByTestId("session-detail-stop")).toBeTruthy();
  });

  // 别的端（另一台桌面端 / 手机）在这条会话上开了一轮：daemon 现在会发
  // `runtime.turnStarted`（wire 2026-09-02 新增），这一屏据此也该显示成在跑。
  // 此前这一路一个信号都没有 —— 只有轮次**结束**看得见，整轮里头部都是灰的。
  it("Given 别的端在这条会话上发了消息 When 收到 turnStarted Then 头部变 Running", async () => {
    wireIdleSession();
    renderPage();
    await screen.findByText(/重构登录页/);
    expect(statusText()).toContain("Idle");

    act(() => capturedOpts.onTurnStarted?.({ conversationId: "42" }));

    await vi.waitFor(() => expect(statusText()).toContain("Running"));
    expect(screen.getByTestId("session-detail-stop")).toBeTruthy();
  });

  // 装载那一刻对端就在跑：`markTurnActive` 在 attach 之后按 lifecycleState 接回来，
  // 头部照样要显示 Running —— 这一档此前是唯一显示对的，不能改回归时丢掉。
  it("Given 装载时对端正在跑 Then 头部一开始就是 Running", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return { sessions: [{ ...summary, lifecycleState: "running" }] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      throw new Error("unexpected: " + method);
    });
    renderPage();
    await screen.findByText(/重构登录页/);

    await vi.waitFor(() => expect(statusText()).toContain("Running"));
  });

  // ── 轮次落定之后:快照要重取,不能停在打开那一刻 ──────────────────────────
  //
  // 「在不在跑」这一维接了实时,其余各维仍退回 attach 那一刻的快照,而 agentred
  // 每次重启都会把非终态会话整批标成 interrupted。于是一条打开时是中断态的对话,
  // 你在它上面跑完一轮之后头部又退回**中断**(红点),而账号镜像那一行早就是 idle
  // 了 —— 同一条对话在左栏与头部同时摆出两种颜色。
  it("Given 打开时报中断 When 一轮跑完 Then 头部按重取到的状态显示", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    let listCalls = 0;
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList) {
        listCalls += 1;
        // 第一次(attach 那一遍)报中断,此后执行端已经把它跑回 idle。
        return {
          sessions: [
            {
              ...summary,
              lifecycleState: listCalls === 1 ? "interrupted" : "idle",
            },
          ],
        };
      }
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun) return {};
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await vi.waitFor(() => expect(statusText()).toContain("Interrupted"));
    await vi.waitFor(() => expect(composerDisabled()).toBe(false));

    act(() => capturedOpts.onRunResultDone?.({} as never));

    await vi.waitFor(() => expect(statusText()).toContain("Idle"));
    expect(statusDotClass()).toContain("bg-status-idle");
  });

  // ── 待决挡在那里:头部与列表行说同一件事 ────────────────────────────────
  //
  // 列表行的判定(共享包 computeAttention)把「有东西等你按」排在「在跑」之前,头部
  // 却在 running 时把等待那一档直接落下 —— 一条卡在审批上的对话,左栏是黄的、头部
  // 是绿的。等待这一维现在有实时来路(pendingWaiters 与快照上那个标志是**同一个**
  // 事实:daemon 的 waitingForInput 就是 len(pendingWaiters) > 0),不必再让给快照。
  it("Given 一轮在跑但有审批挡着 Then 头部说等待输入,而停止照旧摆得出", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return { sessions: [{ ...summary, lifecycleState: "running" }] };
      if (method === rpcMethods.sessionPendingWaiters)
        return {
          toolPermissions: [
            {
              requestId: "req-1",
              toolName: "Bash",
              input: "{}",
            },
          ],
          askUserQuestions: [],
        };
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);

    await vi.waitFor(() =>
      expect(statusText()).toContain("Waiting for your input"),
    );
    expect(statusDotClass()).toContain("bg-status-waiting");
    // 这一轮**确实**还在跑:等待只改状态这一维,停不停得下来是另一件事。
    expect(screen.getByTestId("session-detail-stop")).toBeTruthy();
  });

  // 审批被别的端答掉之后要跟着收回去:等待那一档的来路是实时清单,不是一次性的。
  it("Given 审批被答掉 When 待决清单空了 Then 头部退回 Running", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
      throw new Error("unexpected: " + path);
    });
    let pending = true;
    fakeClient.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return { sessions: [{ ...summary, lifecycleState: "running" }] };
      if (method === rpcMethods.sessionPendingWaiters) {
        if (!pending) return { toolPermissions: [], askUserQuestions: [] };
        return {
          toolPermissions: [
            { requestId: "req-1", toolName: "Bash", input: "{}" },
          ],
          askUserQuestions: [],
        };
      }
      throw new Error("unexpected: " + method);
    });

    renderPage();
    await screen.findByText(/重构登录页/);
    await vi.waitFor(() =>
      expect(statusText()).toContain("Waiting for your input"),
    );

    pending = false;
    act(() =>
      capturedOpts.onEvent?.(
        {
          conversationId: "42",
          event: { kind: "tool_permission_request" },
          seq: 3,
        } as never,
        0,
      ),
    );

    await vi.waitFor(() => expect(statusText()).toContain("Running"));
  });
});
