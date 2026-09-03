import { rpcMethods, type AnyRpcMethod } from "@agentre-hub/agentre-wire";
import type {
  BackendView,
  EngineID,
  EngineSettingsPorts,
  ModelView,
  ProviderView,
} from "@agentre-hub/agentre-ui";

import { api } from "@/lib/api";
import { fetchDevices, type DeviceItem } from "@/lib/devices";
import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

type ProviderDTO = {
  provider_key: string;
  name: string;
  type: string;
  base_url: string;
  masked_tail: string;
  default_model_key: string;
  enabled: boolean;
  models: ModelDTO[];
};

type ModelDTO = {
  model_key: string;
  model_id: string;
  name: string;
  enabled: boolean;
  context_window?: number;
  max_output?: number;
};

type CLIOverlayDTO = {
  backend_sync_id: string;
  fingerprint: string;
  status: "recognized" | "path" | "unchecked";
};

type BackendDTO = {
  sync_id: string;
  name: string;
  type: string;
  device_id: string;
  provider_key: string;
  model_key: string;
  model_routes: string;
  sandbox: string;
  approval: string;
  env_json: string;
  reasoning_effort: string;
  default_permission_mode: string;
  default_model: string;
  openclaw_gateway_url: string;
  openclaw_agent_id: string;
  openclaw_default_model: string;
  openclaw_session_mode: string;
  ref_count: number;
  cli_by_device: Array<{
    fingerprint: string;
    status: "recognized" | "path" | "unchecked";
  }>;
};

type DeviceDTO = DeviceItem;

/**
 * 执行端设备的两种 kind。浏览器与手机登记的是同一份设备表，但它们跑不动 agent，
 * 列出来等于给一个选了也跑不了的选项（规格 2026-08-21 决策 9）。
 *
 * 控制台自己判一次，不是把共享包的筛选抄第二遍：这一页的「有没有可选设备」空态
 * 与端口给出的清单必须是同一个集合，而空态在包外面。包内那道筛选面向的是所有宿主。
 */
const EXECUTION_DEVICE_KINDS = new Set(["desktop", "agentred"]);

export function isExecutionDevice(kind: string): boolean {
  return EXECUTION_DEVICE_KINDS.has(kind);
}

type EngineRPCResult = {
  ok: boolean;
  message: string;
  latencyMs?: number;
};

type EngineDiscoverResult = {
  models: Array<{ modelId: string; name?: string }>;
};

type EngineScanResult = {
  items: Array<{
    backendType: string;
    status: "recognized" | "path" | "unchecked";
  }>;
};

export interface BrowserEngineSettingsMessages {
  noOnlineAgentredReason: string;
  builtinUnsupportedReason: string;
  /** 运行设备必填（决策 5）：没选就地拦下，不发请求。 */
  deviceRequiredReason: string;
  /** 目标机离线：探测与扫描明确失败，绝不退化成「没装」。 */
  deviceOfflineReason: string;
  /** 指纹不在账号内：那台机器已撤销，请改选一台。 */
  deviceUnknownReason: string;
}

class IdentityMap {
  private readonly keyByID = new Map<EngineID, string>();
  private readonly idByKey = new Map<string, EngineID>();

  id(key: string): EngineID {
    const existing = this.idByKey.get(key);
    if (existing !== undefined) return existing;

    // EngineSettingsPorts currently uses numeric IDs for dialog state while the
    // account REST contract correctly uses stable string sync IDs. Keep that
    // mismatch at this adapter boundary; never send this synthetic number over HTTP.
    let id = hashID(key);
    while (this.keyByID.has(id) && this.keyByID.get(id) !== key) id += 1;
    this.keyByID.set(id, key);
    this.idByKey.set(key, id);
    return id;
  }

  key(id: EngineID): string {
    const key = this.keyByID.get(id);
    if (!key) throw new Error(`Unknown engine item: ${id}`);
    return key;
  }

  /** 查得到就给，查不到不是错误 —— 新建草稿的 id 0 本来就没有对应的行。 */
  find(id: EngineID): string | undefined {
    return this.keyByID.get(id);
  }
}

function hashID(value: string): EngineID {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function maskedKey(tail: string): string | undefined {
  const trimmed = tail.trim();
  return trimmed ? `••••${trimmed}` : undefined;
}

function backendName(type: string): string {
  switch (type) {
    case "claudecode":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "piagent":
      return "Pi";
    case "openclaw":
      return "OpenClaw";
    default:
      return type;
  }
}

function providerBody(input: Record<string, unknown>): Record<string, unknown> {
  const models = Array.isArray(input.models)
    ? input.models.map((model) => modelBody(model as Record<string, unknown>))
    : undefined;
  const defaultModelKey = stringValue(
    input.defaultModelKey ?? input.defaultModelId,
  );
  return compact({
    name: input.name,
    type: input.type,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    default_model_key: defaultModelKey,
    models,
    enabled: input.enabled,
  });
}

function modelBody(input: Record<string, unknown>): ModelDTO {
  const modelID = stringValue(input.modelId);
  return {
    model_key: stringValue(input.modelKey) || modelID,
    model_id: modelID,
    name: stringValue(input.name) || modelID,
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    context_window: numberValue(input.contextWindow),
    max_output: numberValue(input.maxOutput),
  };
}

function updateModelBody(
  current: ModelDTO,
  input: Record<string, unknown>,
): ModelDTO {
  return {
    model_key: current.model_key,
    model_id:
      input.modelId === undefined
        ? current.model_id
        : stringValue(input.modelId),
    name: input.name === undefined ? current.name : stringValue(input.name),
    enabled:
      typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    context_window:
      input.contextWindow === undefined
        ? current.context_window
        : numberValue(input.contextWindow),
    max_output:
      input.maxOutput === undefined
        ? current.max_output
        : numberValue(input.maxOutput),
  };
}

function parseModelRoutes(
  value: string,
): Record<string, { providerKey: string; modelKey: string }> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([tier, target]) => {
        if (!target || typeof target !== "object" || Array.isArray(target))
          return [];
        const record = target as Record<string, unknown>;
        const providerKey = stringValue(record.providerKey);
        if (!providerKey) return [];
        return [
          [tier, { providerKey, modelKey: stringValue(record.modelKey) }],
        ];
      }),
    );
  } catch {
    return {};
  }
}

function cliStatus(value: unknown): "recognized" | "path" | "unchecked" {
  return value === "recognized" || value === "path" ? value : "unchecked";
}

function backendBody(input: Record<string, unknown>): Record<string, unknown> {
  return compact({
    name: input.name,
    type: input.type,
    device_id: input.deviceId,
    provider_key: input.llmProviderKey,
    model_key: input.llmModelKey,
    model_routes:
      typeof input.modelRoutes === "string"
        ? input.modelRoutes
        : input.modelRoutes
          ? JSON.stringify(input.modelRoutes)
          : undefined,
    sandbox: input.sandbox,
    approval: input.approval,
    // 编辑器序列化回来的整张表原样发回。缺省（compact 会剔掉 undefined）即不改，
    // 服务端据此保留存着的表——只换设备之类的保存不会顺手把它抹掉。
    env_json: input.envJson,
    reasoning_effort: input.reasoningEffort,
    default_permission_mode: input.defaultPermissionMode,
    default_model: input.defaultModel,
    openclaw_gateway_url: input.openClawGatewayUrl,
    openclaw_agent_id: input.openClawAgentId,
    openclaw_default_model: input.openClawDefaultModel,
    // 会话映射是桌面端 entity 的硬校验：不是 per-agentre-session 就整条判非法。
    // 漏发它等于在账号里存下一条同步下去必被拒的后端。
    openclaw_session_mode: input.openClawSessionMode,
  });
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Browser REST + browser→relay adapter for the shared engine panels. */
export function createBrowserEngineSettingsPorts(
  messages: BrowserEngineSettingsMessages,
): EngineSettingsPorts {
  const providerIDs = new IdentityMap();
  const modelIDs = new IdentityMap();
  const backendIDs = new IdentityMap();
  const providerDTOs = new Map<string, ProviderDTO>();
  const modelLocation = new Map<
    EngineID,
    { providerKey: string; modelKey: string }
  >();
  const backendDTOs = new Map<string, BackendDTO>();
  // 指纹 → 设备名。名字解析不出来正是「设备已撤销」的判据（共享包的
  // backendDeviceLocation），所以这份映射必须来自一次真实的设备读取，
  // 不能靠「还没读过」冒充。
  const deviceNames = new Map<string, string>();
  const deviceScans = new Map<string, Promise<EngineScanResult>>();

  function modelView(provider: ProviderDTO, model: ModelDTO): ModelView {
    const id = modelIDs.id(`${provider.provider_key}:${model.model_key}`);
    modelLocation.set(id, {
      providerKey: provider.provider_key,
      modelKey: model.model_key,
    });
    return {
      id,
      providerId: providerIDs.id(provider.provider_key),
      providerKey: provider.provider_key,
      modelKey: model.model_key,
      modelId: model.model_id,
      name: model.name,
      contextWindow: model.context_window ?? 0,
      maxOutput: model.max_output ?? 0,
      enabled: model.enabled,
      isDefault: provider.default_model_key === model.model_key,
    };
  }

  function providerView(provider: ProviderDTO): ProviderView {
    providerDTOs.set(provider.provider_key, provider);
    return {
      id: providerIDs.id(provider.provider_key),
      providerKey: provider.provider_key,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.base_url,
      maskedApiKey: maskedKey(provider.masked_tail),
      hasApiKey: provider.masked_tail.trim() !== "",
      enabled: provider.enabled,
      defaultModelKey: provider.default_model_key,
      modelCount: provider.models.length,
    };
  }

  async function fetchProviders(): Promise<ProviderDTO[]> {
    const response = await api<{ providers: ProviderDTO[] }>(
      "/v1/engine/providers",
    );
    for (const provider of response.providers ?? []) providerView(provider);
    return response.providers ?? [];
  }

  async function providerForID(id: EngineID): Promise<ProviderDTO> {
    const key = providerIDs.key(id);
    const cached = providerDTOs.get(key);
    if (cached) return cached;
    await fetchProviders();
    const provider = providerDTOs.get(key);
    if (!provider) throw new Error(`Provider is unavailable: ${key}`);
    return provider;
  }

  async function patchProvider(
    provider: ProviderDTO,
    fields: Record<string, unknown>,
  ): Promise<ProviderDTO> {
    const updated = await api<ProviderDTO>(
      `/v1/engine/providers/${encodeURIComponent(provider.provider_key)}`,
      {
        method: "PATCH",
        body: JSON.stringify(fields),
      },
    );
    providerView(updated);
    return updated;
  }

  async function mutateModels(
    providerID: EngineID,
    mutate: (models: ModelDTO[], provider: ProviderDTO) => ModelDTO[],
    extra: Record<string, unknown> = {},
  ): Promise<ProviderDTO> {
    const provider = await providerForID(providerID);
    const models = mutate(
      provider.models.map((model) => ({ ...model })),
      provider,
    );
    return patchProvider(provider, { ...extra, models });
  }

  async function loadDevices(): Promise<DeviceDTO[]> {
    const devices = await fetchDevices();
    deviceNames.clear();
    for (const device of devices) {
      // 没名字的设备退回指纹：名字为空会被读成「这台机器已撤销」，而它明明还在。
      if (device.fingerprint)
        deviceNames.set(device.fingerprint, device.name || device.fingerprint);
    }
    return devices;
  }

  async function onlineAgentred(): Promise<DeviceDTO> {
    const device = (await loadDevices()).find(
      (item) => item.kind === "agentred" && item.online && item.fingerprint,
    );
    if (!device) throw new Error(messages.noOnlineAgentredReason);
    return device;
  }

  // 检测的对象永远是用户点名的那台机器（决策 11）。三种拒绝都在中继之前就说清楚，
  // 因为它们是关于「这次检测发不出去」的陈述，与目标机上装了什么无关。
  async function executionDevice(fingerprint: string): Promise<DeviceDTO> {
    const target = fingerprint.trim();
    if (target === "") throw new Error(messages.deviceRequiredReason);
    const device = (await loadDevices()).find(
      (item) => item.fingerprint === target && isExecutionDevice(item.kind),
    );
    if (!device) throw new Error(messages.deviceUnknownReason);
    if (!device.online) throw new Error(messages.deviceOfflineReason);
    return device;
  }

  async function relayRequest<T>(
    method: AnyRpcMethod,
    params: object = {},
  ): Promise<T> {
    return relayCall<T>((await onlineAgentred()).fingerprint, method, params);
  }

  async function relayCall<T>(
    fingerprint: string,
    method: AnyRpcMethod,
    params: object = {},
  ): Promise<T> {
    return withRelayClient(
      machineTarget(fingerprint),
      async (client) => (await client.request(method, params as never)) as T,
    );
  }

  // 打开新建弹窗会对三个 CLI 类型各探一次同一台机器；共享这一次在飞的 engine.scan
  // 把三次中继往返收成一次。只合并在飞的，不缓存结论：换回同一台机器要重探，
  // 一个过期的「装了」比慢一点危险得多。
  function scanDevice(fingerprint: string): Promise<EngineScanResult> {
    const target = fingerprint.trim();
    const inFlight = deviceScans.get(target);
    if (inFlight) return inFlight;
    const pending = (async () => {
      const device = await executionDevice(target);
      return relayCall<EngineScanResult>(
        device.fingerprint,
        rpcMethods.engineScan,
      );
    })().finally(() => {
      deviceScans.delete(target);
    });
    deviceScans.set(target, pending);
    return pending;
  }

  function requireDevice(input: Record<string, unknown>): string {
    const deviceID = stringValue(input.deviceId).trim();
    if (deviceID === "") throw new Error(messages.deviceRequiredReason);
    return deviceID;
  }

  async function fetchBackends(): Promise<BackendDTO[]> {
    const response = await api<{ backends: BackendDTO[] }>(
      "/v1/engine/backends",
    );
    for (const backend of response.backends ?? []) {
      backendDTOs.set(backend.sync_id, backend);
      backendIDs.id(backend.sync_id);
    }
    return response.backends ?? [];
  }

  async function fetchCLIOverlays(): Promise<CLIOverlayDTO[]> {
    const response = await api<{ overlays: CLIOverlayDTO[] }>(
      "/v1/engine/cli-overlays",
    );
    return response.overlays ?? [];
  }

  function backendView(
    backend: BackendDTO,
    providers: ProviderDTO[],
  ): BackendView {
    const provider = providers.find(
      (item) => item.provider_key === backend.provider_key,
    );
    const model = provider?.models.find(
      (item) => item.model_key === backend.model_key,
    );
    return {
      id: backendIDs.id(backend.sync_id),
      syncId: backend.sync_id,
      name: backend.name,
      type: backend.type,
      llmProviderKey: backend.provider_key,
      llmModelKey: backend.model_key,
      llmProviderName: provider?.name,
      llmProviderType: provider?.type,
      llmProviderModel: model?.name || model?.model_id,
      llmProviderActive:
        backend.provider_key === ""
          ? true
          : Boolean(
              provider?.enabled && (backend.model_key === "" || model?.enabled),
            ),
      modelRoutes: parseModelRoutes(backend.model_routes),
      sandbox: backend.sandbox,
      approval: backend.approval,
      envJson: backend.env_json,
      reasoningEffort: backend.reasoning_effort,
      defaultPermissionMode: backend.default_permission_mode,
      defaultModel: backend.default_model,
      openClawGatewayUrl: backend.openclaw_gateway_url,
      openClawAgentId: backend.openclaw_agent_id,
      openClawDefaultModel: backend.openclaw_default_model,
      agentCount: backend.ref_count,
      deviceId: backend.device_id ?? "",
      // 名字查不到就留空——共享包据此渲染「设备已撤销」；空 deviceId 才是
      // 决策 14 的「未指定设备」。两者是两条不同的如实说法，不能合并。
      deviceName: deviceNames.get(backend.device_id ?? "") ?? "",
      cliByDevice: (backend.cli_by_device ?? []).map((item) => ({
        deviceId: item.fingerprint,
        status: cliStatus(item.status),
      })),
    };
  }

  const ports: EngineSettingsPorts = {
    // 整张 env 表现在随 Backend DTO 下发，控制台因此用的是共享包里桌面端那套编辑器：
    // 读进 entries、改完整体保存。这颗开关同时把一键补 IS_SANDBOX 切回「改本地
    // entries」那条路——与桌面端同一套交互，点完就能在展开的表里看见结果。
    canEditEnvJSON: true,
    canCreateBuiltin: false,
    async listProviders() {
      return (await fetchProviders()).map(providerView);
    },

    async listModels(providerID) {
      const provider = await providerForID(providerID);
      return provider.models.map((model) => modelView(provider, model));
    },

    async createProvider(input) {
      const created = await api<ProviderDTO>("/v1/engine/providers", {
        method: "POST",
        body: JSON.stringify(providerBody(input)),
      });
      return providerView(created);
    },

    async updateProvider(id, input) {
      const provider = await providerForID(id);
      const body = providerBody(input);
      if (input.apiKey === maskedKey(provider.masked_tail)) delete body.api_key;
      const updated = await patchProvider(provider, body);
      return providerView(updated);
    },

    async deleteProvider(id) {
      const key = providerIDs.key(id);
      await api(`/v1/engine/providers/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      providerDTOs.delete(key);
    },

    async setProviderEnabled(id, enabled) {
      const provider = await providerForID(id);
      return providerView(await patchProvider(provider, { enabled }));
    },

    async setModelEnabled(id, enabled) {
      const location = modelLocation.get(id);
      if (!location) throw new Error(`Unknown model: ${id}`);
      const providerID = providerIDs.id(location.providerKey);
      const updated = await mutateModels(providerID, (models) =>
        models.map((model) =>
          model.model_key === location.modelKey ? { ...model, enabled } : model,
        ),
      );
      const model = updated.models.find(
        (item) => item.model_key === location.modelKey,
      );
      if (!model) throw new Error(`Model is unavailable: ${location.modelKey}`);
      return modelView(updated, model);
    },

    async createModels(providerID, inputs) {
      const created = inputs.map((input) =>
        modelBody(input as Record<string, unknown>),
      );
      const createdKeys = new Set(created.map((model) => model.model_key));
      const updated = await mutateModels(providerID, (models) => [
        ...models,
        ...created,
      ]);
      return updated.models
        .filter((model) => createdKeys.has(model.model_key))
        .map((model) => modelView(updated, model));
    },

    async updateModel(id, input) {
      const location = modelLocation.get(id);
      if (!location) throw new Error(`Unknown model: ${id}`);
      const providerID = providerIDs.id(location.providerKey);
      const updated = await mutateModels(providerID, (models) =>
        models.map((model) =>
          model.model_key === location.modelKey
            ? updateModelBody(model, input as Record<string, unknown>)
            : model,
        ),
      );
      const model = updated.models.find(
        (item) => item.model_key === location.modelKey,
      );
      if (!model) throw new Error(`Model is unavailable: ${location.modelKey}`);
      return modelView(updated, model);
    },

    async deleteModel(id) {
      const location = modelLocation.get(id);
      if (!location) throw new Error(`Unknown model: ${id}`);
      await mutateModels(providerIDs.id(location.providerKey), (models) =>
        models.filter((model) => model.model_key !== location.modelKey),
      );
      modelLocation.delete(id);
    },

    async setDefaultModel(providerID, modelID) {
      const provider = await providerForID(providerID);
      const model = provider.models.find(
        (item) =>
          modelIDs.id(`${provider.provider_key}:${item.model_key}`) === modelID,
      );
      if (!model) throw new Error(`Unknown default model: ${modelID}`);
      return providerView(
        await patchProvider(provider, { default_model_key: model.model_key }),
      );
    },

    async listBackends() {
      const [backends, providers, overlays] = await Promise.all([
        fetchBackends(),
        fetchProviders(),
        fetchCLIOverlays(),
        // 设备名与后端行一起读：读失败就整页失败，好过把每一行都说成「设备已撤销」。
        loadDevices(),
      ]);
      const overlaysByBackend = new Map<string, BackendDTO["cli_by_device"]>();
      for (const overlay of overlays) {
        const items = overlaysByBackend.get(overlay.backend_sync_id) ?? [];
        items.push({
          fingerprint: overlay.fingerprint,
          status: cliStatus(overlay.status),
        });
        overlaysByBackend.set(overlay.backend_sync_id, items);
      }
      return backends.map((backend) =>
        backendView(
          {
            ...backend,
            cli_by_device:
              overlaysByBackend.get(backend.sync_id) ?? backend.cli_by_device,
          },
          providers,
        ),
      );
    },

    async createBackend(input) {
      if (input.type === "builtin") {
        throw new Error(messages.builtinUnsupportedReason);
      }
      // 服务端仍是必填校验的权威（code 30904 判指纹是否还在账号内）；这里先拦一道，
      // 是为了「没选设备」这件当场就知道的事不必先发一个注定被拒的请求。
      requireDevice(input);
      const created = await api<BackendDTO>("/v1/engine/backends", {
        method: "POST",
        body: JSON.stringify(backendBody(input)),
      });
      backendDTOs.set(created.sync_id, created);
      const [providers] = await Promise.all([fetchProviders(), loadDevices()]);
      return backendView(created, providers);
    },

    async updateBackend(id, input) {
      requireDevice(input);
      const key = backendIDs.key(id);
      const updated = await api<BackendDTO>(
        `/v1/engine/backends/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          body: JSON.stringify(backendBody(input)),
        },
      );
      backendDTOs.set(key, updated);
      const [providers] = await Promise.all([fetchProviders(), loadDevices()]);
      return backendView(updated, providers);
    },

    async deleteBackend(id) {
      const key = backendIDs.key(id);
      await api(`/v1/engine/backends/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      backendDTOs.delete(key);
    },

    // addIsSandbox 这个 port 本站不实现：env 表整表下发之后，一键补 IS_SANDBOX 走的是
    // 共享包里桌面端那条路（改本地 entries、随整体保存落盘）。服务端那个只收 sync_id
    // 的合并接口也一并删了——它存在的前提是「浏览器读不到这张表」，前提没了。

    async testProvider(providerKey, modelKey) {
      const result = await relayRequest<EngineRPCResult>(
        rpcMethods.engineTest,
        {
          providerKey,
          ...(modelKey ? { modelKey } : {}),
        },
      );
      return {
        ...result,
        openClawAgents: [],
        openClawModels: [],
        grantedScopes: [],
      };
    },

    async discoverModels(providerKey) {
      const result = await relayRequest<EngineDiscoverResult>(
        rpcMethods.engineDiscover,
        { providerKey },
      );
      return (result.models ?? []).map((model) => ({
        id: model.modelId,
        name: model.name,
        vendor: "",
        contextWindow: 0,
        maxOutput: 0,
      }));
    },

    async testBackend(input) {
      let providerKey = stringValue(input.llmProviderKey);
      let modelKey = stringValue(input.llmModelKey);
      let deviceID = stringValue(input.deviceId);
      // id 0 是新建草稿的占位，不是一行后端；查不到就只用入参，别把内部错误抛给用户。
      const key =
        input.id === undefined ? undefined : backendIDs.find(input.id);
      const backend = key === undefined ? undefined : backendDTOs.get(key);
      if (backend) {
        providerKey ||= backend.provider_key;
        modelKey ||= backend.model_key;
        deviceID ||= backend.device_id ?? "";
      }
      // 测的是这个后端将来真正跑的那台机器（决策 11），不是恰好第一台在线的节点：
      // 换一台机器答的「连得上」，对绑在别处的后端没有任何意义。
      const device = await executionDevice(deviceID);
      const result = await relayCall<EngineRPCResult>(
        device.fingerprint,
        rpcMethods.engineTest,
        {
          providerKey,
          ...(modelKey ? { modelKey } : {}),
        },
      );
      return {
        ...result,
        openClawAgents: [],
        openClawModels: [],
        grantedScopes: [],
      };
    },

    async listAccountDevices() {
      return (await loadDevices()).filter(
        (device) => device.fingerprint && isExecutionDevice(device.kind),
      );
    },

    async resolveBackendCLIPath(backendType, deviceId) {
      const result = await scanDevice(stringValue(deviceId));
      const item = (result.items ?? []).find(
        (candidate) => candidate.backendType === backendType,
      );
      // 路径不出浏览器（R19）：三态里只回得起「装了 / 没装」，「没探到」由上面的
      // reject 表达。扫不到这个类型的条目就是那台机器上没有它。
      return { path: "", found: item?.status === "recognized" };
    },

    async scanBackendResults(deviceId) {
      const fingerprint = stringValue(deviceId).trim();
      if (fingerprint === "") throw new Error(messages.deviceRequiredReason);
      const result = await scanDevice(fingerprint);
      const existing = await fetchBackends();
      return Promise.all(
        (result.items ?? []).map(async (item) => {
          const found = item.status === "recognized";
          // 「已经有了」按 (设备, 类型) 判：同一类型在别的机器上已有后端，
          // 不构成在这台机器上跳过的理由（决策 13）。
          const current = existing.find(
            (backend) =>
              backend.type === item.backendType &&
              backend.device_id === fingerprint,
          );
          if (!found) {
            return {
              name: backendName(item.backendType),
              found: false,
              created: false,
              skipped: false,
            };
          }
          if (current) {
            return {
              name: current.name,
              found: true,
              created: false,
              skipped: true,
            };
          }
          const created = await ports.createBackend({
            type: item.backendType,
            name: backendName(item.backendType),
            deviceId: fingerprint,
          });
          return {
            name: created.name,
            found: true,
            created: true,
            skipped: false,
          };
        }),
      );
    },
  };

  return ports;
}
