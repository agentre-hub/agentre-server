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
  urls: [] as string[],
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
    constructor(options: { url: string }) {
      relay.urls.push(options.url);
    }
    connect = relay.connect;
    request = relay.request;
    close = relay.close;
  },
}));

/** 中继连到了哪台机器：URL 里的 daemon_fingerprint 就是被检测的那一台。 */
function relayTargets(): string[] {
  return relay.urls.map(
    (url) =>
      new URLSearchParams(url.slice(url.indexOf("?"))).get(
        "daemon_fingerprint",
      ) ?? "",
  );
}

const mockedApi = vi.mocked(api);
const mockedEnsureRelayTicket = vi.mocked(ensureRelayTicket);

function ports() {
  return createBrowserEngineSettingsPorts({
    noOnlineAgentredReason: "No online agentred is available.",
    builtinUnsupportedReason: "Built-in backends cannot be created here.",
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
  relay.urls.length = 0;
  relay.connect.mockResolvedValue(undefined);
  mockedEnsureRelayTicket.mockResolvedValue({
    accessToken: "ticket",
    clientId: "browser-fp",
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
  device_id: string;
}) {
  return {
    ...fields,
    provider_key: "",
    model_key: "",
    model_routes: "",
    sandbox: "",
    approval: "",
    reasoning_effort: "",
    default_permission_mode: "",
    default_model: "",
    openclaw_gateway_url: "",
    openclaw_agent_id: "",
    openclaw_default_model: "",
    openclaw_session_mode: "",
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
              model_routes:
                '{"OPUS":{"providerKey":"openai-main","modelKey":"gpt-5"}}',
              sandbox: "workspace-write",
              approval: "on-request",
              reasoning_effort: "high",
              default_permission_mode: "acceptEdits",
              default_model: "gpt-5",
              openclaw_gateway_url: "",
              openclaw_agent_id: "",
              openclaw_default_model: "",
              openclaw_session_mode: "",
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

  it("probes the CLI on the named device, telling installed from not installed", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request.mockResolvedValue({
      items: [
        { backendType: "claudecode", status: "recognized" },
        { backendType: "codex", status: "unchecked" },
      ],
    });

    const adapter = ports();
    await expect(
      adapter.resolveBackendCLIPath!("claudecode", "agentred-b"),
    ).resolves.toEqual({ found: true, path: "" });
    await expect(
      adapter.resolveBackendCLIPath!("codex", "agentred-b"),
    ).resolves.toEqual({ found: false, path: "" });

    // 同一台机器上的两次探测搭同一条中继：此前是各拨一条，各握一次手。
    expect(relayTargets()).toEqual(["agentred-b"]);
    expect(relay.request).toHaveBeenCalledWith(rpcMethods.engineScan, {});
  });

  it("asks the named device once for a whole group of probes", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return devicesResponse();
      throw new Error(`unexpected api call: ${path}`);
    });
    relay.request.mockResolvedValue({
      items: [{ backendType: "claudecode", status: "recognized" }],
    });

    const adapter = ports();
    await Promise.all([
      adapter.resolveBackendCLIPath!("claudecode", "agentred-b"),
      adapter.resolveBackendCLIPath!("codex", "agentred-b"),
      adapter.resolveBackendCLIPath!("piagent", "agentred-b"),
    ]);

    expect(relay.request).toHaveBeenCalledTimes(1);
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
          device_id: String(body.device_id),
        });
      }
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-1",
              name: "Claude Code",
              type: "claudecode",
              device_id: "desktop-a",
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
      ],
    });

    // 同一类型在别的机器上已有后端，不构成在这台上跳过的理由。
    await expect(ports().scanBackendResults!("agentred-b")).resolves.toEqual([
      { name: "Claude Code", found: true, created: true, skipped: false },
      { name: "Codex", found: false, created: false, skipped: false },
    ]);
    expect(relayTargets()).toEqual(["agentred-b"]);
    expect(posted).toEqual([
      { name: "Claude Code", type: "claudecode", device_id: "agentred-b" },
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
              device_id: "agentred-b",
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
          device_id: "agentred-b",
        });
      }
      if (path === "/v1/engine/backends/backend-1") {
        return backendDTO({
          sync_id: "backend-1",
          name: "Builder · Claude Code",
          type: "claudecode",
          device_id: "desktop-a",
        });
      }
      if (path === "/v1/engine/backends") {
        return {
          backends: [
            backendDTO({
              sync_id: "backend-1",
              name: "Builder · Claude Code",
              type: "claudecode",
              device_id: "agentred-b",
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
    ).toMatchObject({ device_id: "agentred-b" });

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
    ).toMatchObject({ device_id: "desktop-a" });

    const before = calls.length;
    await expect(
      adapter.createBackend({ type: "codex", name: "Codex" }),
    ).rejects.toThrow("Pick the device this backend runs on.");
    await expect(
      adapter.updateBackend(listed.id, { type: "claudecode", name: "x" }),
    ).rejects.toThrow("Pick the device this backend runs on.");
    expect(calls.length).toBe(before);
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
          device_id: "agentred-b",
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
      openclaw_session_mode: "per-agentre-session",
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
                device_id: "agentred-b",
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
              device_id: "desktop-a",
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
              device_id: "agentred-b",
            }),
            backendDTO({
              sync_id: "backend-2",
              name: "On a revoked machine",
              type: "codex",
              device_id: "gone-x",
            }),
            backendDTO({
              sync_id: "backend-3",
              name: "Legacy",
              type: "codex",
              device_id: "",
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
