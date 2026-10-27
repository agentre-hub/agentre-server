/**
 * 会话详情页的模型 pill · CLI 自带模型段（规格 2026-10-26「agentre-server web 控制台」
 * 的「会话模型 pill」）。
 *
 * 共享 pill / 弹层与桌面端同一份；宿主这里接的是：
 *   - 列表经中继向**承载这条会话的机器**查询（listCLIModelsOn 在这里被桩掉，
 *     它自己的往返由 cli-models.test.ts 钉着）；
 *   - 切换经 setSessionCLIModel 写到承载机器，再写回发起端（两处写、全失败才回滚）；
 *   - 承载机是 agentred 且空闲时先 runtimeSetCLIModel 热切（-32010 = 没有在跑的 CLI，
 *     只落库；其它拒绝 = 切换没生效，不写）；
 *   - 一轮进行中选的只挂起，下一轮开始前 pill 写 `<当前> → <新>`；
 *   - 与供应商目标互斥；每一轮 runtime.run 带上会话当前的 CLI 选择。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ErrCodeNoActiveTurn,
  rpcMethods,
  SessionLifecycleRunning,
} from "@agentre-hub/agentre-wire";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";
import SessionDetailView from "@/components/session/SessionDetailView";
import { writeCLIModelToOrigin } from "@/components/session/sessionMirror";
import {
  useRelayChannel,
  type UseRelayChannelOptions,
} from "@/hooks/use-relay";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { listCLIModelsOn } from "@/lib/cliModels";
import { RelayError } from "@/lib/relayClient";
import { resetLiveTurns } from "@/lib/liveSessions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));
vi.mock("@/components/session/sessionMirror", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/session/sessionMirror")>();
  return { ...actual, writeCLIModelToOrigin: vi.fn(async () => {}) };
});
vi.mock("@/lib/cliModels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cliModels")>();
  return { ...actual, listCLIModelsOn: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);
const mockWriteOrigin = vi.mocked(writeCLIModelToOrigin);
const mockListCLIModels = vi.mocked(listCLIModelsOn);

let capturedOpts: UseRelayChannelOptions = {};

const fakeClient = {
  request: vi.fn(),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  setCursor: vi.fn(),
  getCursor: vi.fn(() => 0),
  close: vi.fn(),
};

const CLI_CATALOG = {
  models: [
    { value: "sonnet", label: "CLI Sonnet", modelId: "claude-sonnet-4-6" },
    { value: "opus", label: "CLI Opus", modelId: "claude-opus-4-7" },
  ],
  effectiveValue: "sonnet",
  effectiveModelId: "claude-sonnet-4-6",
};

interface Scenario {
  carrierKind?: "agentred" | "desktop";
  origin?: string;
  /** 后端绑定的供应商；空 = CLI 登录态。 */
  backendProvider?: string;
  defaultModel?: string;
  cliModelMode?: string;
  cliModel?: string;
  running?: boolean;
  setSessionCLIModel?: () => unknown;
  runtimeSetCLIModel?: () => unknown;
}

function wire(s: Scenario = {}) {
  const deviceRow = {
    id: 1,
    name: "书房小主机",
    kind: s.carrierKind ?? "agentred",
    fingerprint: "fp-1",
    last_seen_at: 1754000000000,
    status: 1,
    online: true,
  };
  mockedApi.mockImplementation(async (path) => {
    if (path === "/v1/devices") return { devices: [deviceRow] };
    // 账号镜像那一行：落库的 CLI 选择从这里读得到（中继摘要的解码此刻不带这两格）。
    if (path === "/v1/agent-sessions?conversation_id=42")
      return {
        items: [
          {
            conversation_id: "42",
            peer_fingerprint: s.origin ?? "",
            device_fingerprint: "fp-1",
            agent_sync_id: "ag-1",
            backend_type: "claudecode",
            cli_model_mode: s.cliModelMode ?? "",
            cli_model: s.cliModel ?? "",
          },
        ],
      };
    if (path.startsWith("/v1/agent-sessions/transcript"))
      return { frames: [], cursor: 0, has_more: false };
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
            type: "claudecode",
            env_json: "{}",
            device_fingerprint: "fp-1",
            provider_key: s.backendProvider ?? "",
            model_key: s.backendProvider ? "haiku" : "",
            reasoning_effort: "",
            config: {
              defaultPermissionMode: "default",
              defaultModel: s.defaultModel ?? "sonnet",
            },
          },
        ],
      };
    if (path === "/v1/engine/cli-overlays")
      return {
        overlays: [
          {
            backend_sync_id: "backend-1",
            fingerprint: "fp-1",
            cli_path: "/opt/claude",
          },
        ],
      };
    if (path === "/v1/engine/providers")
      return {
        providers: [
          {
            provider_key: "anthropic",
            name: "Gateway",
            type: "anthropic",
            default_model_key: "haiku",
            enabled: true,
            models: [
              {
                model_key: "haiku",
                model_id: "claude-haiku-4-5",
                name: "Gateway Haiku",
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
            conversationId: "42",
            title: "重构登录页",
            agentSyncId: "ag-1",
            cwd: "/home/agent/proj",
            backendType: "claudecode",
            lifecycleState: s.running ? SessionLifecycleRunning : "idle",
            latestSeq: 2,
            peerFingerprint: s.origin,
            providerKey: "",
            modelKey: "",
            cliModelMode: s.cliModelMode ?? "",
            cliModel: s.cliModel ?? "",
          },
        ],
      };
    if (method === rpcMethods.sessionPendingWaiters)
      return { toolPermissions: [], askUserQuestions: [] };
    if (method === rpcMethods.runtimeCapabilities)
      return { capabilities: [], permissionMode: { allowedModes: [] } };
    if (method === rpcMethods.setSessionCLIModel)
      return s.setSessionCLIModel ? s.setSessionCLIModel() : {};
    if (method === rpcMethods.runtimeSetCLIModel)
      return s.runtimeSetCLIModel ? s.runtimeSetCLIModel() : {};
    if (method === rpcMethods.setModelTarget) return {};
    if (method === rpcMethods.runtimeRun) return {};
    throw new Error("unexpected: " + String(method?.name ?? method));
  });
}

function renderPage() {
  mockUseRelay.mockImplementation((_fp, opts) => {
    capturedOpts = opts ?? {};
    return {
      client: fakeClient as never,
      relayState: "connected",
      relayTicket: {
        peerFingerprint: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      handshakeRejection: null,
      reconnect: vi.fn(),
    };
  });
  return render(
    <MemoryRouter initialEntries={["/chat/42"]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/chat/42"
            element={<SessionDetailView deviceId={1} conversationId="42" />}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const pill = () => screen.getByRole("button", { name: /Provider and model/ });

/** 等到 CLI 目录落地（脸上出现解析出来的展示名）。 */
async function awaitFace(text: string) {
  await waitFor(() => expect(pill().textContent).toContain(text), {
    timeout: 3_000,
  });
}

async function pickOption(name: RegExp) {
  fireEvent.click(pill());
  const matches = await screen.findAllByRole("option", { name });
  expect(matches, `弹层里 ${String(name)} 不止一项`).toHaveLength(1);
  fireEvent.click(matches[0]);
}

function calls(method: unknown) {
  return fakeClient.request.mock.calls.filter(([m]) => m === method);
}

function composerEditable(): HTMLElement & {
  editor?: { commands: { setContent: (v: string) => void } };
} {
  const el = document.querySelector<HTMLElement>(
    '[data-testid="session-detail-composer"] .ProseMirror',
  );
  if (!el) throw new Error("输入框没渲染出来");
  return el;
}

async function sendInComposer(text: string) {
  await waitFor(() => composerEditable());
  await waitFor(() =>
    expect(composerEditable().getAttribute("contenteditable")).toBe("true"),
  );
  composerEditable().editor?.commands.setContent(`<p>${text}</p>`);
  fireEvent.keyDown(composerEditable(), { key: "Enter" });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  capturedOpts = {};
  mockWriteOrigin.mockReset();
  mockWriteOrigin.mockResolvedValue(undefined);
  mockListCLIModels.mockReset();
  mockListCLIModels.mockResolvedValue(CLI_CATALOG);
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockClear();
  fakeClient.catchUp.mockImplementation(async () => {});
  fakeClient.getCursor.mockReturnValue(0);
  resetLiveTurns();
  localStorage.clear();
});

describe("会话模型 pill · CLI 自带模型的脸", () => {
  it("Given 会话从没在 CLI 段选过 When 打开 Then 脸写「跟随 Agent 绑定 · <后端默认模型>」并带品牌标识，目录问的是承载机", async () => {
    wire({ defaultModel: "sonnet" });
    renderPage();

    await awaitFace("Follow agent binding · CLI Sonnet");
    expect(pill().querySelector("[data-brand]")).not.toBeNull();
    expect(mockListCLIModels).toHaveBeenCalledWith(
      "fp-1",
      expect.objectContaining({ sync_id: "backend-1", type: "claudecode" }),
      { refresh: false },
      "/opt/claude",
    );
  });

  it("Given 会话固定了 CLI 模型 When 打开 Then 脸就写那个模型、不写跟随", async () => {
    wire({ cliModelMode: "fixed", cliModel: "opus" });
    renderPage();

    await awaitFace("CLI Opus");
    expect(pill().textContent).not.toContain("Follow agent binding");
    expect(screen.queryByTestId("provider-pill-dynamic-icon")).toBeNull();
  });

  it("Given 会话跟随 CLI 默认且上一轮报了模型 When 打开 Then 脸写解析到的模型并带 ↻", async () => {
    wire({ cliModelMode: "cli-default" });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "上一轮" },
        seq: 1,
      });
      capturedOpts.onRunResultDone?.({
        conversationId: "42",
        seq: 2,
        model: "claude-opus-4-7",
      } as never);
    });
    renderPage();

    await awaitFace("CLI Opus");
    expect(screen.getByTestId("provider-pill-dynamic-icon")).toBeTruthy();
  });

  it("Given 后端绑了 Agentre 供应商 When 打开弹层 Then 没有 CLI 段、也不去问 CLI 目录", async () => {
    wire({ backendProvider: "anthropic" });
    renderPage();

    await awaitFace("Gateway Haiku");
    fireEvent.click(pill());
    await screen.findAllByRole("option", { name: /Gateway Haiku/ });
    expect(screen.queryByRole("option", { name: /CLI Opus/ })).toBeNull();
    expect(mockListCLIModels).not.toHaveBeenCalled();
  });
});

describe("会话模型 pill · 切换写到哪", () => {
  it("Given 桌面端承载、发起端是另一台 When 选一个 CLI 模型 Then 承载机与发起端各写一次 setSessionCLIModel，不热切", async () => {
    wire({ carrierKind: "desktop", origin: "fp-origin" });
    renderPage();
    await awaitFace("CLI Sonnet");

    await pickOption(/CLI Opus/);

    await awaitFace("CLI Opus");
    expect(calls(rpcMethods.setSessionCLIModel)[0]?.[1]).toMatchObject({
      conversationId: "42",
      peerFingerprint: "fp-origin",
      mode: "fixed",
      value: "opus",
    });
    expect(mockWriteOrigin).toHaveBeenCalledWith("fp-origin", {
      conversationId: "42",
      mode: "fixed",
      value: "opus",
    });
    expect(calls(rpcMethods.runtimeSetCLIModel)).toHaveLength(0);
  });

  it("Given 只写成一台 When 选 Then 选择留着并如实说另一台没跟上", async () => {
    wire({ carrierKind: "desktop", origin: "fp-origin" });
    mockWriteOrigin.mockRejectedValueOnce(new Error("origin offline"));
    renderPage();
    await awaitFace("CLI Sonnet");

    await pickOption(/CLI Opus/);

    await awaitFace("CLI Opus");
    expect(
      (await screen.findByTestId("composer-model-note")).textContent,
    ).toContain("has not caught up");
  });

  it("Given 两台都写不进去 When 选 Then 脸不变，弹层底部说切换没生效", async () => {
    wire({
      carrierKind: "desktop",
      origin: "fp-origin",
      setSessionCLIModel: () => {
        throw new Error("carrier says no");
      },
    });
    mockWriteOrigin.mockRejectedValueOnce(new Error("origin offline"));
    renderPage();
    await awaitFace("CLI Sonnet");

    await pickOption(/CLI Opus/);

    expect(
      await screen.findByText(/Switch did not take effect: .*carrier says no/),
    ).toBeTruthy();
    expect(pill().textContent).toContain("Follow agent binding · CLI Sonnet");
  });

  it("Given agentred 承载且空闲 When 选 Then 先 runtimeSetCLIModel 热切再落库", async () => {
    wire({ carrierKind: "agentred" });
    renderPage();
    await awaitFace("CLI Sonnet");

    await pickOption(/CLI Opus/);

    await awaitFace("CLI Opus");
    const order = fakeClient.request.mock.calls
      .map(([m]) => m)
      .filter(
        (m) =>
          m === rpcMethods.runtimeSetCLIModel ||
          m === rpcMethods.setSessionCLIModel,
      );
    expect(order).toEqual([
      rpcMethods.runtimeSetCLIModel,
      rpcMethods.setSessionCLIModel,
    ]);
    expect(calls(rpcMethods.runtimeSetCLIModel)[0]?.[1]).toMatchObject({
      conversationId: "42",
      value: "opus",
    });
  });

  it("Given agentred 上没有在跑的 CLI（-32010）When 选 Then 只落库", async () => {
    wire({
      carrierKind: "agentred",
      runtimeSetCLIModel: () => {
        throw new RelayError(ErrCodeNoActiveTurn, "no active turn");
      },
    });
    renderPage();
    await awaitFace("CLI Sonnet");

    await pickOption(/CLI Opus/);

    await awaitFace("CLI Opus");
    expect(calls(rpcMethods.setSessionCLIModel)).toHaveLength(1);
    expect(screen.queryByText(/Switch did not take effect/)).toBeNull();
  });

  it("Given agentred 的 CLI 拒绝了这个模型 When 选 Then 不写任何一台，弹层底部写 CLI 原文", async () => {
    wire({
      carrierKind: "agentred",
      origin: "fp-origin",
      runtimeSetCLIModel: () => {
        throw new RelayError(-32000, "model opus not found");
      },
    });
    renderPage();
    await awaitFace("CLI Sonnet");

    await pickOption(/CLI Opus/);

    expect(
      await screen.findByText(
        /Switch did not take effect: .*model opus not found/,
      ),
    ).toBeTruthy();
    expect(calls(rpcMethods.setSessionCLIModel)).toHaveLength(0);
    expect(mockWriteOrigin).not.toHaveBeenCalled();
    expect(pill().textContent).toContain("Follow agent binding · CLI Sonnet");
  });

  it("Given 一轮正在跑 When 选 Then 只落库不热切，脸写「当前 → 新」", async () => {
    wire({ carrierKind: "agentred", running: true });
    fakeClient.catchUp.mockImplementation(async () => {
      capturedOpts.onEvent?.({
        conversationId: "42",
        event: { kind: "text_delta", text: "上一轮" },
        seq: 1,
      });
      capturedOpts.onRunResultDone?.({
        conversationId: "42",
        seq: 2,
        model: "claude-sonnet-4-6",
      } as never);
    });
    renderPage();
    await awaitFace("CLI Sonnet");
    await waitFor(() =>
      expect(screen.getByTestId("session-detail-stop")).toBeTruthy(),
    );

    await pickOption(/CLI Opus/);

    await awaitFace("CLI Sonnet → CLI Opus");
    expect(calls(rpcMethods.setSessionCLIModel)).toHaveLength(1);
    expect(calls(rpcMethods.runtimeSetCLIModel)).toHaveLength(0);
  });

  it("Given 选择没变 When 再点同一项 Then 什么都不写", async () => {
    wire({ carrierKind: "agentred", cliModelMode: "fixed", cliModel: "opus" });
    renderPage();
    await awaitFace("CLI Opus");

    await pickOption(/CLI Opus/);
    await act(async () => {});

    expect(calls(rpcMethods.setSessionCLIModel)).toHaveLength(0);
    expect(calls(rpcMethods.runtimeSetCLIModel)).toHaveLength(0);
  });
});

describe("会话模型 pill · 与供应商目标互斥、随下一轮过线", () => {
  it("Given 会话固定了 CLI 模型 When 选一个 Agentre 供应商模型 Then CLI 选择清掉，下一轮不再带它", async () => {
    wire({ carrierKind: "agentred", cliModelMode: "fixed", cliModel: "opus" });
    renderPage();
    await awaitFace("CLI Opus");

    await pickOption(/^Gateway Haiku/);

    await awaitFace("Gateway Haiku");
    await sendInComposer("下一轮");
    await waitFor(() => expect(calls(rpcMethods.runtimeRun)).toHaveLength(1));
    const run = calls(rpcMethods.runtimeRun)[0]?.[1] as Record<string, unknown>;
    expect(run).toMatchObject({
      llmProviderKey: "anthropic",
      llmModelKey: "haiku",
    });
    expect(run.cliModelMode ?? "").toBe("");
    expect(run.cliModel ?? "").toBe("");
  });

  it("Given 选了一个 CLI 模型 When 发下一条 Then runtime.run 带着这次的选择", async () => {
    wire({ carrierKind: "agentred" });
    renderPage();
    await awaitFace("CLI Sonnet");

    await pickOption(/CLI Opus/);
    await awaitFace("CLI Opus");
    await sendInComposer("用新模型");

    await waitFor(() => expect(calls(rpcMethods.runtimeRun)).toHaveLength(1));
    expect(calls(rpcMethods.runtimeRun)[0]?.[1]).toMatchObject({
      cliModelMode: "fixed",
      cliModel: "opus",
    });
  });

  it("Given 会话落库的是跟随 CLI 默认 When 发一条 Then runtime.run 带着它", async () => {
    wire({ carrierKind: "agentred", cliModelMode: "cli-default" });
    renderPage();
    await sendInComposer("照旧");

    await waitFor(() => expect(calls(rpcMethods.runtimeRun)).toHaveLength(1));
    expect(calls(rpcMethods.runtimeRun)[0]?.[1]).toMatchObject({
      cliModelMode: "cli-default",
    });
  });
});
