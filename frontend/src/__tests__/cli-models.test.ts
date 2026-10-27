import { rpcMethods } from "@agentre-hub/agentre-wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { listCLIModelsOn, resetCLIModelsCache } from "@/lib/cliModels";
import { createBrowserEngineSettingsPorts } from "@/lib/enginePorts";
import { relayClientPool } from "@/lib/relayClientPool";
import { ensureRelayTicket } from "@/lib/relayTicket";

const relay = vi.hoisted(() => ({
  connect: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
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
    connect = relay.connect;
    request = relay.request;
    close = relay.close;
  },
}));

const mockedApi = vi.mocked(api);

const backend = {
  sync_id: "b-codex",
  type: "codex",
  env_json: '{"A":"1"}',
  reasoning_effort: "high",
  config: { defaultPermissionMode: "plan" },
};

const wireResponse = {
  models: [
    {
      value: "gpt-x",
      displayName: "GPT X",
      modelId: "gpt-x-1",
      group: "g",
      legacy: true,
    },
  ],
  effectiveValue: "gpt-x",
  effectiveModelId: "gpt-x-1",
};

beforeEach(() => {
  relayClientPool.closeAll();
  resetCLIModelsCache();
  mockedApi.mockReset();
  relay.connect.mockReset().mockResolvedValue(undefined);
  relay.request.mockReset().mockResolvedValue(wireResponse);
  relay.close.mockReset();
  vi.mocked(ensureRelayTicket).mockResolvedValue({
    accessToken: "t",
    expiresAt: Date.now() + 120_000,
    peerFingerprint: "browser-fp",
    clientName: "Browser",
  });
});

describe("listCLIModelsOn", () => {
  it("encodes the request and maps the response to a catalog", async () => {
    const catalog = await listCLIModelsOn(
      "fp-1",
      backend,
      { refresh: false },
      "/opt/codex",
    );

    expect(relay.request).toHaveBeenCalledWith(rpcMethods.cliModelsList, {
      backendType: "codex",
      cliPath: "/opt/codex",
      envJson: '{"A":"1"}',
      defaultPermissionMode: "plan",
      reasoningEffort: "high",
    });
    expect(catalog).toEqual({
      models: [
        {
          value: "gpt-x",
          label: "GPT X",
          modelId: "gpt-x-1",
          group: "g",
          legacy: true,
        },
      ],
      effectiveValue: "gpt-x",
      effectiveModelId: "gpt-x-1",
    });
  });

  it("serves repeat calls from cache and lets refresh bypass and replace it", async () => {
    const call = (refresh: boolean) =>
      listCLIModelsOn("fp-1", backend, { refresh }, "");
    await call(false);
    await call(false);
    expect(relay.request).toHaveBeenCalledTimes(1);

    relay.request.mockResolvedValue({ ...wireResponse, models: [] });
    const refreshed = await call(true);
    expect(relay.request).toHaveBeenCalledTimes(2);
    expect(refreshed.models).toEqual([]);
    expect((await call(false)).models).toEqual([]);
    expect(relay.request).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by device and backend", async () => {
    await listCLIModelsOn("fp-1", backend, { refresh: false }, "");
    await listCLIModelsOn("fp-2", backend, { refresh: false }, "");
    expect(relay.request).toHaveBeenCalledTimes(2);
  });

  // 规格「模型列表与解析的获取」：后端配置变化（CLI 路径、环境变量、绑定）使缓存失效。
  it.each([
    ["the CLI path", { ...backend }, "/other/codex"],
    ["the environment", { ...backend, env_json: '{"A":"2"}' }, ""],
    ["the binding", { ...backend, provider_key: "prov-1" }, ""],
  ])(
    "Given a cached catalog, When %s changes, Then the next list asks the CLI again",
    async (_what, changed, cliPath) => {
      await listCLIModelsOn("fp-1", backend, { refresh: false }, "");
      relay.request.mockResolvedValue({ ...wireResponse, models: [] });

      const next = await listCLIModelsOn(
        "fp-1",
        changed,
        { refresh: false },
        cliPath,
      );

      expect(relay.request).toHaveBeenCalledTimes(2);
      expect(next.models).toEqual([]);
    },
  );

  it("passes relay errors through unchanged and does not cache them", async () => {
    relay.request.mockRejectedValueOnce(new Error("cli exploded"));
    await expect(
      listCLIModelsOn("fp-1", backend, { refresh: false }, ""),
    ).rejects.toThrow("cli exploded");
    await expect(
      listCLIModelsOn("fp-1", backend, { refresh: false }, ""),
    ).resolves.toBeTruthy();
  });
});

describe("ports.listCLIModels", () => {
  function setup(online: boolean, deviceFp = "agentred-b") {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 2,
              name: "Builder",
              kind: "agentred",
              platform: "linux",
              version: "1",
              fingerprint: "agentred-b",
              last_seen_at: 1,
              status: 1,
              online,
              is_this_device: false,
            },
          ],
        };
      if (path === "/v1/engine/backends")
        return {
          backends: [
            {
              ...backend,
              name: "Codex",
              device_fingerprint: deviceFp,
              provider_key: "",
              model_key: "",
              ref_count: 0,
              cli_by_device: [],
            },
          ],
        };
      if (path === "/v1/engine/cli-overlays")
        return {
          overlays: [
            {
              backend_sync_id: "b-codex",
              fingerprint: "agentred-b",
              status: "path",
              cli_path: "/custom/codex",
            },
          ],
        };
      if (path === "/v1/engine/providers") return { providers: [] };
      throw new Error(`unexpected ${path}`);
    });
    const ports = createBrowserEngineSettingsPorts({
      noOnlineAgentredReason: "none",
      builtinUnsupportedReason: "b",
      unsupportedBackendReason: "u",
      deviceRequiredReason: "pick a device",
      deviceOfflineReason: "device offline",
      deviceUnknownReason: "device unknown",
      credentialErrorReason: () => "cred",
    });
    return ports;
  }

  it("lists models on the backend's execution device with the overlay cli path", async () => {
    const ports = setup(true);
    const [view] = await ports.listBackends();
    const catalog = await ports.listCLIModels!({
      backendId: view.id,
      refresh: false,
    });
    expect(catalog.models[0].value).toBe("gpt-x");
    expect(relay.request).toHaveBeenCalledWith(
      rpcMethods.cliModelsList,
      expect.objectContaining({
        cliPath: "/custom/codex",
        backendType: "codex",
      }),
    );
  });

  it("rejects with the offline reason when the device is offline", async () => {
    const ports = setup(false);
    const [view] = await ports.listBackends();
    await expect(
      ports.listCLIModels!({ backendId: view.id, refresh: false }),
    ).rejects.toThrow("device offline");
    expect(relay.request).not.toHaveBeenCalled();
  });

  it("rejects with the device-required reason when no device is bound", async () => {
    const ports = setup(true, "");
    const [view] = await ports.listBackends();
    await expect(
      ports.listCLIModels!({ backendId: view.id, refresh: false }),
    ).rejects.toThrow("pick a device");
  });
});
