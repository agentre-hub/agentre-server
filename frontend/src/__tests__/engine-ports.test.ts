import { rpcMethods } from "@agentre-hub/agentre-wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { relayClientPool } from "@/lib/relayClientPool";
import { createBrowserEngineSettingsPorts } from "@/lib/enginePorts";
import { ensureRelayTicket } from "@/lib/relayTicket";

const relay = vi.hoisted(() => ({
  connect: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  targets: [] as string[],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/relayTicket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayTicket")>();
  return { ...actual, ensureRelayTicket: vi.fn() };
});

vi.mock("@/lib/relayClient", () => ({
  RelayClient: class {
    constructor(options: { target: string }) {
      relay.targets.push(options.target);
    }
    connect = relay.connect;
    request = relay.request;
    close = relay.close;
  },
}));

/**
 * 中继开到了哪台机器：通道声明的目标就是被检测的那一台。
 *
 * URL 上已经没有目标了（决策 10）——一个账号一条连接，目标由每条虚拟通道自己声明。
 */
function relayTargets(): string[] {
  return relay.targets.map((target) => target.replace(/^machine:/, ""));
}

const mockedApi = vi.mocked(api);
const mockedEnsureRelayTicket = vi.mocked(ensureRelayTicket);

function ports() {
  return createBrowserEngineSettingsPorts({
    noOnlineAgentredReason: "No online agentred is available.",
    builtinUnsupportedReason: "Built-in backends cannot be created here.",
    unsupportedBackendReason: "This backend type is unavailable here.",
    deviceRequiredReason: "Pick the device this backend runs on.",
    deviceOfflineReason: "That device is offline, so nothing was probed.",
    deviceUnknownReason: "That device is no longer in this account.",
  });
}

beforeEach(() => {
  // 中继连接是池化的（relayClientPool）：不收掉的话，上一条用例建的那条会被下一条
  // 借走，于是「拨了哪几台」「建了几条」这些断言全部读到上一条的残留。
  relayClientPool.closeAll();
  mockedApi.mockReset();
  mockedEnsureRelayTicket.mockReset();
  relay.connect.mockReset();
  relay.request.mockReset();
  relay.close.mockReset();
  relay.targets.length = 0;
  relay.connect.mockResolvedValue(undefined);
  mockedEnsureRelayTicket.mockResolvedValue({
    accessToken: "ticket",
    expiresAt: Date.now() + 120_000,
    peerFingerprint: "browser-fp",
    clientName: "Browser",
  });
});

/** /v1/devices 的真实形状（server 契约）：一台离线桌面端、一台在线 agentred、一个浏览器。 */
function devicesResponse() {
  return {
    devices: [
      {
        id: 1,
        name: "Studio",
        kind: "desktop",
        platform: "darwin",
        version: "1.0.0",
        fingerprint: "desktop-a",
        last_seen_at: 1,
        status: 1,
        online: false,
        is_this_device: false,
      },
      {
        id: 2,
        name: "Builder",
        kind: "agentred",
        platform: "linux",
        version: "1.0.0",
        fingerprint: "agentred-b",
        last_seen_at: 2,
        status: 1,
        online: true,
        is_this_device: false,
      },
      {
        id: 3,
        name: "Chrome",
        kind: "web",
        platform: "web",
        version: "",
        fingerprint: "browser-c",
        last_seen_at: 3,
        status: 1,
        online: true,
        is_this_device: true,
      },
    ],
  };
}

function backendDTO(fields: {
  sync_id: string;
  name: string;
  type: string;
  device_fingerprint: string;
  env_json?: string;
}) {
  return {
    env_json: "",
    ...fields,
    provider_key: "",
    model_key: "",
    reasoning_effort: "",
    // 九个平铺字段已删（S2）：单类型独占设置整体收在 config 这一个对象里。
    config: {},
    ref_count: 0,
    cli_by_device: [],
  };
}

describe("browser engine settings ports", () => {
  it("maps the REST DTOs to display views without carrying plaintext keys or CLI paths", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") {
        return {
          providers: [
            {
              provider_key: "anthropic-main",
              name: "Anthropic",
              type: "anthropic",
              base_url: "https://api.anthropic.com",
              masked_tail: "1234",
              api_key: "sk-plaintext-must-not-cross",
              default_model_key: "sonnet",
              enabled: true,
              models: [
                {
                  model_key: "sonnet",
                  model_id: "claude-sonnet-4",
                  name: "Sonnet",
                  enabled: true,
                  context_window: 200000,
                  max_output: 8192,
                },
              ],
            },
          ],
        };
      }
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            {
              sync_id: "backend-1",
              name: "Claude Code",
              type: "claudecode",
              provider_key: "anthropic-main",
              model_key: "sonnet",
              ref_count: 2,
              cli_path: "/Users/dev/.local/bin/claude",
              cli_by_device: [],
            },
          ],
        };
      }
      if (path === "/v1/engine/cli-overlays") {
        return {
          overlays: [
            {
              backend_sync_id: "backend-1",
              fingerprint: "agentred-1",
              status: "recognized",
              cli_path: "/Users/dev/.local/bin/claude",
            },
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    const providers = await adapter.listProviders();
    const backends = await adapter.listBackends();
    const renderedData = JSON.stringify({ providers, backends });

    expect(providers[0].maskedApiKey).toBe("••••1234");
    expect(providers[0].hasApiKey).toBe(true);
    expect(backends[0].cliByDevice).toEqual([
      { deviceId: "agentred-1", status: "recognized" },
    ]);
    expect(renderedData).not.toContain("sk-plaintext-must-not-cross");
    expect(renderedData).not.toContain("/Users/dev/.local/bin/claude");
    expect(renderedData).not.toContain("api_key");
    expect(renderedData).not.toContain("cli_path");
  });

  /**
   * config 对象双向映射的读半边：九个平铺字段已删（S2），单类型独占设置整体
   * 收在 backend.config 这一个 JSON 对象里，openclaw 四个键在契约里是全小写
   * 前缀（openclawGatewayUrl 等），不是共享包 BackendView 上的 openClaw*。
   */
  it("keeps account-safe backend options when loading an existing backend for editing", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            {
              sync_id: "backend-1",
              name: "Codex",
              type: "codex",
              provider_key: "openai-main",
              model_key: "gpt-5",
              env_json: "",
              reasoning_effort: "high",
              config: {
                modelRoutes: {
                  OPUS: { providerKey: "openai-main", modelKey: "gpt-5" },
                },
                sandbox: "workspace-write",
                approval: "on-request",
                defaultPermissionMode: "acceptEdits",
                defaultModel: "gpt-5",
              },
              ref_count: 0,
              cli_by_device: [],
            },
          ],
        };
      }
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      throw new Error(`unexpected api call: ${path}`);
    });

    const [backend] = await ports().listBackends();

    expect(backend).toMatchObject({
      modelRoutes: { OPUS: { providerKey: "openai-main", modelKey: "gpt-5" } },
      sandbox: "workspace-write",
      approval: "on-request",
      reasoningEffort: "high",
      defaultPermissionMode: "acceptEdits",
      defaultModel: "gpt-5",
    });
  });

  /** 旧平铺格式的行（或压根没写过）读作 config 缺席：映射到「没配」，不是崩溃。 */
  it("reads a legacy row with no config object as unconfigured, not broken", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            {
              sync_id: "backend-legacy",
              name: "Legacy Codex",
              type: "codex",
              provider_key: "openai-main",
              model_key: "gpt-5",
              env_json: "",
              reasoning_effort: "",
              config: null,
              ref_count: 0,
              cli_by_device: [],
            },
          ],
        };
      }
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      throw new Error(`unexpected api call: ${path}`);
    });

    const [backend] = await ports().listBackends();

    expect(backend).toMatchObject({
      modelRoutes: {},
      sandbox: "",
      approval: "",
      defaultPermissionMode: "",
      defaultModel: "",
    });
  });

  it("does not send the masked credential back when editing a provider", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/engine/providers" && !init) {
        return {
          providers: [
            {
              provider_key: "anthropic-main",
              name: "Anthropic",
              type: "anthropic",
              base_url: "https://api.anthropic.com",
              masked_tail: "1234",
              default_model_key: "",
              enabled: true,
              models: [],
            },
          ],
        };
      }
      if (path === "/v1/engine/providers/anthropic-main") {
        return {
          provider_key: "anthropic-main",
          name: "Anthropic Updated",
          type: "anthropic",
          base_url: "https://api.anthropic.com",
          masked_tail: "1234",
          default_model_key: "",
          enabled: true,
          models: [],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    const [provider] = await adapter.listProviders();
    await adapter.updateProvider(provider.id, {
      type: "anthropic",
      name: "Anthropic Updated",
      baseUrl: "https://api.anthropic.com",
      apiKey: provider.maskedApiKey,
    });

    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.path).toBe("/v1/engine/providers/anthropic-main");
    expect(JSON.parse(String(patch?.init?.body))).not.toHaveProperty("api_key");
  });

  /**
   * 单模型写入端点（S3）：启停一个模型只经 PATCH .../models/:model_key，请求体
   * 只带 {enabled}，绝不把整份 models 数组经供应商 PATCH 带回去——那条路正是
   * Problem 9「陈旧页面整表覆盖」的根：浏览器缓存的模型列表一旦过期，回发整表
   * 会把其它设备并发加的/改的模型悄悄撤回。
   */
  it("toggles one model through the single-model PATCH endpoint, never the whole models list", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/engine/providers" && !init) {
        return {
          providers: [
            {
              provider_key: "anthropic-main",
              name: "Anthropic",
              type: "anthropic",
              base_url: "https://api.anthropic.com",
              masked_tail: "1234",
              default_model_key: "sonnet",
              enabled: true,
              models: [
                {
                  model_key: "sonnet",
                  model_id: "claude-sonnet-4",
                  name: "Sonnet",
                  enabled: true,
                },
                {
                  model_key: "haiku",
                  model_id: "claude-haiku",
                  name: "Haiku",
                  enabled: true,
                },
              ],
            },
          ],
        };
      }
      if (path === "/v1/engine/providers/anthropic-main/models/haiku") {
        return {
          provider_key: "anthropic-main",
          name: "Anthropic",
          type: "anthropic",
          base_url: "https://api.anthropic.com",
          masked_tail: "1234",
          default_model_key: "sonnet",
          enabled: true,
          models: [
            {
              model_key: "sonnet",
              model_id: "claude-sonnet-4",
              name: "Sonnet",
              enabled: true,
            },
            {
              model_key: "haiku",
              model_id: "claude-haiku",
              name: "Haiku",
              enabled: false,
            },
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    const [provider] = await adapter.listProviders();
    const models = await adapter.listModels(provider.id);
    const haiku = models.find((model) => model.modelKey === "haiku")!;
    await adapter.setModelEnabled(haiku.id, false);

    const modelPatch = calls.find(
      (call) => call.init?.method === "PATCH" && call.path.includes("/models/"),
    );
    expect(modelPatch?.path).toBe(
      "/v1/engine/providers/anthropic-main/models/haiku",
    );
    expect(JSON.parse(String(modelPatch?.init?.body))).toEqual({
      enabled: false,
    });
    // 整份供应商 PATCH（不带 /models/ 的那条）绝不该发生——那才是旧的
    // mutateModels 整表回发路径。
    expect(
      calls.some(
        (call) =>
          call.init?.method === "PATCH" && !call.path.includes("/models/"),
      ),
    ).toBe(false);
  });

  it("adds and deletes a model through the single-model POST/DELETE endpoints", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const providerBase = {
      provider_key: "anthropic-main",
      name: "Anthropic",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      masked_tail: "1234",
      default_model_key: "",
      enabled: true,
    };
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/engine/providers" && !init) {
        return { providers: [{ ...providerBase, models: [] }] };
      }
      if (
        path === "/v1/engine/providers/anthropic-main/models" &&
        init?.method === "POST"
      ) {
        return {
          ...providerBase,
          models: [
            {
              model_key: "claude-opus-4",
              model_id: "claude-opus-4",
              name: "Opus",
              enabled: true,
            },
          ],
        };
      }
      if (
        path === "/v1/engine/providers/anthropic-main/models/claude-opus-4" &&
        init?.method === "DELETE"
      ) {
        return { ...providerBase, models: [] };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    const [provider] = await adapter.listProviders();
    const [created] = await adapter.createModels(provider.id, [
      { modelId: "claude-opus-4", name: "Opus" },
    ]);

    const post = calls.find(
      (call) => call.init?.method === "POST" && call.path.endsWith("/models"),
    );
    expect(post?.path).toBe("/v1/engine/providers/anthropic-main/models");
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      model_key: "claude-opus-4",
    });

    await adapter.deleteModel(created.id);

    const del = calls.find((call) => call.init?.method === "DELETE");
    expect(del?.path).toBe(
      "/v1/engine/providers/anthropic-main/models/claude-opus-4",
    );
    expect(del?.init?.body).toBeUndefined();
  });

  it("fails device actions visibly when no agentred is online, without minting a relay ticket", async () => {
    mockedApi.mockResolvedValue({
      devices: [
        { kind: "agentred", online: false, fingerprint: "offline" },
        { kind: "web", online: true, fingerprint: "browser" },
      ],
    });

    await expect(ports().testProvider!("anthropic-main")).rejects.toThrow(
      "No online agentred is available.",
    );
    expect(mockedEnsureRelayTicket).not.toHaveBeenCalled();
    expect(relay.request).not.toHaveBeenCalled();
  });

  it("routes provider test and discovery through RelayClient engine RPCs", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request
      .mockResolvedValueOnce({ ok: true, message: "connection succeeded" })
      .mockResolvedValueOnce({
        models: [{ modelId: "claude-sonnet-4", name: "Sonnet" }],
      });

    const adapter = ports();
    await expect(
      adapter.testProvider!("anthropic-main", "sonnet"),
    ).resolves.toMatchObject({ ok: true });
    await expect(adapter.discoverModels!("anthropic-main")).resolves.toEqual([
      {
        id: "claude-sonnet-4",
        name: "Sonnet",
        vendor: "",
        contextWindow: 0,
        maxOutput: 0,
      },
    ]);

    expect(relay.request).toHaveBeenNthCalledWith(1, rpcMethods.engineTest, {
      providerKey: "anthropic-main",
      modelKey: "sonnet",
    });
    expect(relay.request).toHaveBeenNthCalledWith(
      2,
      rpcMethods.engineDiscover,
      {
        providerKey: "anthropic-main",
      },
    );
    // 两次调用打在同一台机器上，因此共用池子里那**一条**连接，而且谁都不关它
    // （关连接的权力只在 relayClientPool 手里，见它的 release/空闲宽限）。
    expect(relayTargets()).toEqual(["agentred-b"]);
    expect(relay.close).not.toHaveBeenCalled();
  });

  it("lists only the account devices that can actually run a backend", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      throw new Error(`unexpected api call: ${path}`);
    });

    await expect(ports().listAccountDevices!()).resolves.toEqual([
      {
        id: 1,
        name: "Studio",
        kind: "desktop",
        platform: "darwin",
        version: "1.0.0",
        fingerprint: "desktop-a",
        last_seen_at: 1,
        status: 1,
        online: false,
        is_this_device: false,
      },
      {
        id: 2,
        name: "Builder",
        kind: "agentred",
        platform: "linux",
        version: "1.0.0",
        fingerprint: "agentred-b",
        last_seen_at: 2,
        status: 1,
        online: true,
        is_this_device: false,
      },
    ]);
  });

  it("reports a failed device listing as a retryable failure, never as an empty account", async () => {
    mockedApi.mockRejectedValue(
      new Error("devices are temporarily unavailable"),
    );

    await expect(ports().listAccountDevices!()).rejects.toThrow(
      "devices are temporarily unavailable",
    );
  });

  /**
   * 探测要回**真实路径**，不只是「装没装」。
   *
   * 共享包的「自动识别」按钮是 `r.found ? r.path : null`：回一个 found=true 但 path
   * 为空的结果，按钮会在 CLI 明明装着的时候显示「没找到」。所以这里改调 cliResolvePath
   * ——daemon 上本来就注册着这个方法，回 {path, found}，和桌面端调的是同一个。
   *
   * 代价是每个类型各拨一次 RPC（engineScan 一次能答三个类型，但它按设计不带路径）。
   * 连接仍是池化的同一条，多的只是帧。
   */
  it("resolves the real CLI path on the named device", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request.mockImplementation(
      async (_method: unknown, params: unknown) =>
        (params as { type: string }).type === "claudecode"
          ? { path: "/usr/local/bin/claude", found: true }
          : { path: "", found: false },
    );

    const adapter = ports();
    await expect(
      adapter.resolveBackendCLIPath!("claudecode", "agentred-b"),
    ).resolves.toEqual({ found: true, path: "/usr/local/bin/claude" });
    await expect(
      adapter.resolveBackendCLIPath!("codex", "agentred-b"),
    ).resolves.toEqual({ found: false, path: "" });

    expect(relayTargets()).toEqual(["agentred-b"]);
    expect(relay.request).toHaveBeenCalledWith(rpcMethods.cliResolvePath, {
      type: "claudecode",
    });
  });

  it("says a probe was never answered instead of inventing 'not installed'", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    // 没点名机器：探测根本没有发出，那是关于探测的陈述，不是关于机器的。
    await expect(
      adapter.resolveBackendCLIPath!("claudecode", ""),
    ).rejects.toThrow("Pick the device this backend runs on.");
    // 离线：探不到，同样不能说成没装。
    await expect(
      adapter.resolveBackendCLIPath!("claudecode", "desktop-a"),
    ).rejects.toThrow("That device is offline, so nothing was probed.");
    // 指纹不在账号内：机器已撤销。
    await expect(
      adapter.resolveBackendCLIPath!("claudecode", "gone-x"),
    ).rejects.toThrow("That device is no longer in this account.");
    // 中继不通同样落到「没探到」，而不是一个否定结论。
    relay.request.mockRejectedValueOnce(new Error("relay is unreachable"));
    await expect(
      adapter.resolveBackendCLIPath!("claudecode", "agentred-b"),
    ).rejects.toThrow("relay is unreachable");
    expect(mockedEnsureRelayTicket).toHaveBeenCalledTimes(1);
  });

  it("scans the device the user named and skips by (device, type)", async () => {
    const posted: Array<Record<string, unknown>> = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/backends" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        return backendDTO({
          sync_id: "backend-new",
          name: String(body.name),
          type: String(body.type),
          device_fingerprint: String(body.device_fingerprint),
        });
      }
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-1",
              name: "Claude Code",
              type: "claudecode",
              device_fingerprint: "desktop-a",
            }),
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request.mockResolvedValue({
      items: [
        { backendType: "claudecode", status: "recognized" },
        { backendType: "codex", status: "unchecked" },
        // daemon 可以比 browser host 新；未声明的类型必须在任何写入前被忽略。
        { backendType: "hermes", status: "recognized" },
      ],
    });

    // 同一类型在别的机器上已有后端，不构成在这台上跳过的理由。
    await expect(ports().scanBackendResults!("agentred-b")).resolves.toEqual([
      { name: "Claude Code", found: true, created: true, skipped: false },
      { name: "Codex", found: false, created: false, skipped: false },
    ]);
    expect(relayTargets()).toEqual(["agentred-b"]);
    expect(posted).toEqual([
      {
        name: "Claude Code",
        type: "claudecode",
        device_fingerprint: "agentred-b",
      },
    ]);

    // 目标离线时扫描明确失败，不退到别的机器上扫。
    await expect(ports().scanBackendResults!("desktop-a")).rejects.toThrow(
      "That device is offline, so nothing was probed.",
    );
  });

  it("skips a type that already exists on that very device", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-1",
              name: "Builder · Claude Code",
              type: "claudecode",
              device_fingerprint: "agentred-b",
            }),
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request.mockResolvedValue({
      items: [{ backendType: "claudecode", status: "recognized" }],
    });

    await expect(ports().scanBackendResults!("agentred-b")).resolves.toEqual([
      {
        name: "Builder · Claude Code",
        found: true,
        created: false,
        skipped: true,
      },
    ]);
  });

  it("refuses to scan a machine nobody named instead of picking one by luck", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      throw new Error(`unexpected api call: ${path}`);
    });

    await expect(ports().scanBackendResults!()).rejects.toThrow(
      "Pick the device this backend runs on.",
    );
    expect(relay.request).not.toHaveBeenCalled();
    expect(mockedEnsureRelayTicket).not.toHaveBeenCalled();
  });

  it("carries the chosen device through create and edit, and blocks a save without one", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      if (path === "/v1/engine/backends" && init?.method === "POST") {
        return backendDTO({
          sync_id: "backend-1",
          name: "Builder · Claude Code",
          type: "claudecode",
          device_fingerprint: "agentred-b",
        });
      }
      if (path === "/v1/engine/backends/backend-1") {
        return backendDTO({
          sync_id: "backend-1",
          name: "Builder · Claude Code",
          type: "claudecode",
          device_fingerprint: "desktop-a",
        });
      }
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-1",
              name: "Builder · Claude Code",
              type: "claudecode",
              device_fingerprint: "agentred-b",
            }),
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    const created = await adapter.createBackend({
      type: "claudecode",
      name: "Builder · Claude Code",
      deviceId: "agentred-b",
    });
    expect(created.deviceId).toBe("agentred-b");
    expect(created.deviceName).toBe("Builder");
    expect(
      JSON.parse(
        String(calls.find((c) => c.init?.method === "POST")?.init?.body),
      ),
    ).toMatchObject({ device_fingerprint: "agentred-b" });

    const [listed] = await adapter.listBackends();
    await adapter.updateBackend(listed.id, {
      type: "claudecode",
      name: "Builder · Claude Code",
      deviceId: "desktop-a",
    });
    expect(
      JSON.parse(
        String(calls.find((c) => c.init?.method === "PATCH")?.init?.body),
      ),
    ).toMatchObject({ device_fingerprint: "desktop-a" });

    const before = calls.length;
    await expect(
      adapter.createBackend({ type: "codex", name: "Codex" }),
    ).rejects.toThrow("Pick the device this backend runs on.");
    await expect(
      adapter.updateBackend(listed.id, { type: "claudecode", name: "x" }),
    ).rejects.toThrow("Pick the device this backend runs on.");
    expect(calls.length).toBe(before);
  });

  it("declares supported backend types and rejects Hermes writes before transport", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-hermes",
              name: "Hermes",
              type: "hermes",
              device_fingerprint: "desktop-a",
            }),
          ],
        };
      }
      return backendDTO({
        sync_id: "backend-hermes",
        name: "Hermes",
        type: "hermes",
        device_fingerprint: "desktop-a",
      });
    });

    const adapter = ports();
    expect(adapter.supportedBackendTypes).toEqual([
      "claudecode",
      "codex",
      "piagent",
      "openclaw",
    ]);
    const [hermes] = await adapter.listBackends();
    const unsupported = "This backend type is unavailable here.";

    await expect(
      adapter.createBackend({
        type: "hermes",
        name: "Hermes",
        deviceId: "desktop-a",
      }),
    ).rejects.toThrow(unsupported);
    await expect(
      adapter.updateBackend(hermes.id, {
        type: "hermes",
        name: "Hermes",
        deviceId: "desktop-a",
      }),
    ).rejects.toThrow(unsupported);
    await expect(
      adapter.testBackend!({ id: hermes.id, type: "", name: "" }),
    ).rejects.toThrow(unsupported);
  });

  /**
   * env 表整表往返：读得回来才编辑得动。
   *
   * 这张表此前不下发浏览器，控制台因此既列不出用户在桌面端填过的透传环境变量，也改
   * 不了它——同一份配置两个入口两种能力。放开后宿主要做的只有两件事：把 DTO 上的
   * env_json 映成共享包的 envJson，以及把编辑器序列化回来的那张表原样发回去。
   */
  it("maps the env table in both directions", async () => {
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "CC",
          type: "claudecode",
          device_fingerprint: "desktop-a",
          env_json: '{"HTTPS_PROXY":"http://127.0.0.1:7890"}',
        });
      }
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      return {
        backends: [
          backendDTO({
            sync_id: "backend-1",
            name: "CC",
            type: "claudecode",
            device_fingerprint: "desktop-a",
            env_json: '{"MY_TOKEN":"s3cret"}',
          }),
        ],
      };
    });

    const adapter = ports();
    const [listed] = await adapter.listBackends();
    expect(listed.envJson).toBe('{"MY_TOKEN":"s3cret"}');

    const saved = await adapter.updateBackend(listed.id, {
      type: "claudecode",
      name: "CC",
      deviceId: "desktop-a",
      envJson: '{"HTTPS_PROXY":"http://127.0.0.1:7890"}',
      changedFields: ["envJson"],
    });
    expect(bodies[0]).toMatchObject({
      env_json: '{"HTTPS_PROXY":"http://127.0.0.1:7890"}',
    });
    expect(saved.envJson).toBe('{"HTTPS_PROXY":"http://127.0.0.1:7890"}');
  });

  /**
   * 保存只发 changedFields 点名的字段：编辑弹窗改了一个名字，PATCH 体里除了
   * 服务端每次都要的 device_fingerprint（它是必填的写入元数据，不是「这次改没
   * 改」的产物——校验落在服务层，无条件解引用），不该多带任何东西。
   */
  it("sends only the changed top-level field when nothing else was touched", async () => {
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "New Name",
          type: "claudecode",
          device_fingerprint: "desktop-a",
        });
      }
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      return {
        backends: [
          backendDTO({
            sync_id: "backend-1",
            name: "Old Name",
            type: "claudecode",
            device_fingerprint: "desktop-a",
          }),
        ],
      };
    });

    const adapter = ports();
    const [listed] = await adapter.listBackends();
    await adapter.updateBackend(listed.id, {
      type: "claudecode",
      name: "New Name",
      deviceId: "desktop-a",
      changedFields: ["name"],
    });

    expect(bodies[0]).toEqual({
      device_fingerprint: "desktop-a",
      name: "New Name",
    });
  });

  /**
   * 任一 config.* 命中就把 config 整个带上（共享包契约：config 是带则整体替换），
   * 但仍然只有这一个键——不连带任何没在 changedFields 里出现的顶层字段。
   */
  it("sends only the whole config object when a config field changed", async () => {
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "CC",
          type: "claudecode",
          device_fingerprint: "desktop-a",
        });
      }
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      return {
        backends: [
          backendDTO({
            sync_id: "backend-1",
            name: "CC",
            type: "claudecode",
            device_fingerprint: "desktop-a",
          }),
        ],
      };
    });

    const adapter = ports();
    const [listed] = await adapter.listBackends();
    await adapter.updateBackend(listed.id, {
      type: "claudecode",
      name: "CC",
      deviceId: "desktop-a",
      defaultPermissionMode: "acceptEdits",
      changedFields: ["config.defaultPermissionMode"],
    });

    // 契约：config 里空值键省略（syncwire.AgentBackendConfig 全部 omitempty）。
    expect(bodies[0]).toEqual({
      device_fingerprint: "desktop-a",
      config: { defaultPermissionMode: "acceptEdits" },
    });
  });

  it("sends an emptied config as {} rather than a bag of empty-string keys", async () => {
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "CC",
          type: "claudecode",
          device_fingerprint: "desktop-a",
        });
      }
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      return {
        backends: [
          backendDTO({
            sync_id: "backend-1",
            name: "CC",
            type: "claudecode",
            device_fingerprint: "desktop-a",
          }),
        ],
      };
    });

    const adapter = ports();
    const [listed] = await adapter.listBackends();
    await adapter.updateBackend(listed.id, {
      type: "claudecode",
      name: "CC",
      deviceId: "desktop-a",
      defaultPermissionMode: "",
      modelRoutes: {},
      changedFields: ["config.defaultPermissionMode"],
    });

    expect(bodies[0]).toEqual({ device_fingerprint: "desktop-a", config: {} });
  });

  /**
   * 读得到整表，编辑器就该开——这颗开关是共享包渲染 EnvJsonField 的唯一门控，
   * 也是那颗一键补 IS_SANDBOX 走「改本地 entries」还是「调服务端合并」的分水岭。
   * 关着它，控制台就退回只能补一个固定键、什么也看不见的老样子。
   */
  it("opens the shared env editor now that the table is readable", () => {
    expect(ports().canEditEnvJSON).toBe(true);
  });

  /**
   * cli_path 的读回：按 (后端, **调用方点名的设备**) 取——不是这条后端当前绑定
   * 的设备。编辑器换了设备但还没保存时，这里要能立刻答出新设备已存的值；挑错
   * （比如仍按 backend.device_fingerprint 找）就会把旧设备的路径显示成新设备的。
   */
  it("reads back the CLI path of whichever device the caller names", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/engine/cli-overlays")
        return {
          overlays: [
            {
              backend_sync_id: "backend-1",
              fingerprint: "agentred-b",
              status: "recognized",
              cli_path: "/other/machine/claude",
            },
            {
              backend_sync_id: "backend-1",
              fingerprint: "desktop-a",
              status: "recognized",
              cli_path: "/usr/local/bin/claude",
            },
          ],
        };
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    // 这条后端此刻绑的是 agentred-b（见下一个用例），但调用方点名 desktop-a——
    // get 要照给 desktop-a 那一条，不能被「这条后端绑在哪」带偏。
    await expect(adapter.cliPath!.get("backend-1", "desktop-a")).resolves.toBe(
      "/usr/local/bin/claude",
    );
    await expect(adapter.cliPath!.get("backend-1", "agentred-b")).resolves.toBe(
      "/other/machine/claude",
    );
    await expect(
      adapter.cliPath!.get("backend-1", "gone-x"),
    ).resolves.toBeNull();
  });

  /**
   * cli_path 的保存：它**不**随 updateBackend 的整份草稿一起编码（见
   * updateBackendBody 的注释），而是这个独立端口——device_fingerprint 与
   * cli_path 必须在同一次 PATCH 里一起发，落在调用方给的那台设备上，不是这条
   * 后端存着的那个。
   */
  it("writes the CLI path against whichever device the caller names", async () => {
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "CC",
          type: "claudecode",
          device_fingerprint: "agentred-b",
        });
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    await adapter.cliPath!.set(
      "backend-1",
      "agentred-b",
      "/opt/homebrew/bin/claude",
    );
    await adapter.cliPath!.set(
      "backend-1",
      "desktop-a",
      "/usr/local/bin/claude",
    );

    expect(bodies).toEqual([
      {
        cli_path: "/opt/homebrew/bin/claude",
        device_fingerprint: "agentred-b",
      },
      { cli_path: "/usr/local/bin/claude", device_fingerprint: "desktop-a" },
    ]);
  });

  /**
   * 保存整份草稿不再顺带发 cli_path：可执行文件路径专走 cliPath 端口，两条
   * 请求各管各的，不会因为 changedFields 里出现 "cliPath" 就在 updateBackend
   * 的 PATCH 体里再重复写一遍、落到跟 cliPath.set 不同的设备上。
   */
  it("never carries cliPath inside the updateBackend body, even when it changed", async () => {
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "CC",
          type: "claudecode",
          device_fingerprint: "desktop-a",
        });
      }
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      return {
        backends: [
          backendDTO({
            sync_id: "backend-1",
            name: "CC",
            type: "claudecode",
            device_fingerprint: "desktop-a",
          }),
        ],
      };
    });

    const adapter = ports();
    const [listed] = await adapter.listBackends();
    await adapter.updateBackend(listed.id, {
      type: "claudecode",
      name: "CC",
      deviceId: "desktop-a",
      cliPath: "/opt/homebrew/bin/claude",
      changedFields: ["cliPath"],
    });

    expect(bodies[0]).toEqual({ device_fingerprint: "desktop-a" });
  });

  // 端口契约的另一半：单独改路径时也要带上设备。共享编辑器现在把**设备**作为第二个
  // 参数交进来（切设备写的是另一行）；实现若还按旧的 (backendSyncId, path) 两个参数
  // 收，设备标识会被当成路径写进 cli_path——而少参数的函数签名在 TS 里仍可赋给多参数
  // 的端口方法，类型检查不会红。这条用例看的是实际发出的请求。
  it("writes the CLI path against the device the editor passes", async () => {
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "CC",
          type: "claudecode",
          device_fingerprint: "desktop-a",
        });
      }
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      return { backends: [] };
    });

    await ports().cliPath!.set(
      "backend-1",
      "desktop-a",
      "/opt/homebrew/bin/claude",
    );

    expect(bodies[0]).toMatchObject({
      cli_path: "/opt/homebrew/bin/claude",
      device_fingerprint: "desktop-a",
    });
  });

  it("carries the OpenClaw session mapping through create and edit", async () => {
    // 会话映射是桌面端 entity 的硬校验（不是 per-agentre-session 就整条判非法）。
    // 控制台漏发这一个字段，等于在服务端存下一条同步下去必被拒的后端。
    const bodies: unknown[] = [];
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST" || init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return backendDTO({
          sync_id: "backend-1",
          name: "Gateway",
          type: "openclaw",
          device_fingerprint: "agentred-b",
        });
      }
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      throw new Error(`unexpected api call: ${path}`);
    });

    await ports().createBackend({
      type: "openclaw",
      name: "Gateway",
      deviceId: "agentred-b",
      openClawGatewayUrl: "ws://127.0.0.1:18789",
      openClawSessionMode: "per-agentre-session",
    });

    expect(bodies[0]).toMatchObject({
      config: expect.objectContaining({
        openclawGatewayUrl: "ws://127.0.0.1:18789",
        openclawSessionMode: "per-agentre-session",
      }),
    });
  });

  it("tests a backend on the machine it is bound to, not on whichever node answered first", async () => {
    // 账号里有两台在线 agentred；后端绑的是排在后面的那一台。旧实现取「第一台在线的」，
    // 于是 B 机回的「连得上」被当成 A 机的结论 —— 那是一句和这个后端无关的话。
    const twoOnlineNodes = {
      devices: [
        { ...devicesResponse().devices[1], fingerprint: "agentred-first" },
        { ...devicesResponse().devices[1], fingerprint: "agentred-b" },
      ],
    };
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return twoOnlineNodes;
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            {
              ...backendDTO({
                sync_id: "backend-1",
                name: "Builder · Claude Code",
                type: "claudecode",
                device_fingerprint: "agentred-b",
              }),
              provider_key: "anthropic-main",
              model_key: "sonnet",
            },
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request.mockResolvedValue({ ok: true, message: "ok", latencyMs: 12 });

    const adapter = ports();
    const [listed] = await adapter.listBackends();
    await adapter.testBackend!({ id: listed.id, type: "", name: "" });

    expect(relayTargets()).toEqual(["agentred-b"]);
  });

  it("refuses to test a backend whose machine is offline instead of asking another one", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-1",
              name: "Studio · Claude Code",
              type: "claudecode",
              device_fingerprint: "desktop-a",
            }),
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const adapter = ports();
    const [listed] = await adapter.listBackends();
    await expect(
      adapter.testBackend!({ id: listed.id, type: "", name: "" }),
    ).rejects.toThrow("That device is offline, so nothing was probed.");
    expect(relayTargets()).toEqual([]);
  });

  it("tests a draft that has no saved row yet on the device the draft names", async () => {
    // 新建弹窗里点「测试连接」传的是 id 0 —— 那是「还没有这一行」的意思，
    // 不是一个查得到的后端；照着它去查表只会把一句内部错误糊到用户脸上。
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request.mockResolvedValue({ ok: true, message: "ok", latencyMs: 9 });

    const result = await ports().testBackend!({
      id: 0,
      type: "claudecode",
      name: "Draft",
      deviceId: "agentred-b",
      llmProviderKey: "anthropic-main",
    });

    expect(result.ok).toBe(true);
    expect(relayTargets()).toEqual(["agentred-b"]);
  });

  it("tells a revoked device apart from a backend that never named one", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-1",
              name: "On Builder",
              type: "claudecode",
              device_fingerprint: "agentred-b",
            }),
            backendDTO({
              sync_id: "backend-2",
              name: "On a revoked machine",
              type: "codex",
              device_fingerprint: "gone-x",
            }),
            backendDTO({
              sync_id: "backend-3",
              name: "Legacy",
              type: "codex",
              device_fingerprint: "",
            }),
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    const backends = await ports().listBackends();

    expect(backends.map((b) => [b.deviceId, b.deviceName])).toEqual([
      ["agentred-b", "Builder"],
      ["gone-x", ""],
      ["", ""],
    ]);
  });
});
