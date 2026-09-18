import { rpcMethods, type AnyRpcMethod } from "@agentre-hub/agentre-wire";
import type {
  BackendView,
  BackendType,
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
  cli_path: string;
};

/**
 * 后端的单类型独占设置对象。键表归 syncwire.AgentBackendConfig：camelCase，但
 * openclaw 四个键在契约里是全小写前缀 `openclaw*`（不是共享包 BackendView /
 * BackendInput 上的 `openClaw*`），映射两侧时这一处大小写必须显式换。
 */
type BackendConfigDTO = {
  modelRoutes?: Record<string, { providerKey: string; modelKey: string }>;
  sandbox?: string;
  approval?: string;
  defaultPermissionMode?: string;
  defaultModel?: string;
  openclawGatewayUrl?: string;
  openclawAgentId?: string;
  openclawDefaultModel?: string;
  openclawSessionMode?: string;
  hermesUrl?: string;
  hermesAuthProvider?: string;
  hermesUserId?: string;
};

type BackendDTO = {
  sync_id: string;
  name: string;
  type: string;
  device_fingerprint: string;
  provider_key: string;
  model_key: string;
  env_json: string;
  reasoning_effort: string;
  // 九个平铺字段已删（S2）：单类型独占设置现在整体收在这一个 JSON 对象里，
  // 旧平铺格式的行服务端读作 {}。
  config: BackendConfigDTO | null;
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
const BROWSER_BACKEND_TYPES = [
  "claudecode",
  "codex",
  "piagent",
  "openclaw",
] as const satisfies readonly BackendType[];
const BROWSER_BACKEND_TYPE_SET = new Set<string>(BROWSER_BACKEND_TYPES);

function assertSupportedBackendType(type: string, reason: string): void {
  if (!BROWSER_BACKEND_TYPE_SET.has(type)) {
    throw new Error(reason);
  }
}

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
  unsupportedBackendReason: string;
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

/**
 * 单模型 PATCH（S3 端点）只带调用方实际给了的那几个字段——服务端按「带则替换、
 * 缺省保留」处理，其它模型与这一个模型未提的字段都不受影响。不再像旧
 * `updateModelBody` 那样拿当前值补全整条：那是给「发一整条 ModelDTO」这件事
 * 准备的，单模型端点不需要。
 */
function modelPatchBody(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return compact({
    model_id:
      input.modelId === undefined ? undefined : stringValue(input.modelId),
    name: input.name === undefined ? undefined : stringValue(input.name),
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    context_window:
      input.contextWindow === undefined
        ? undefined
        : numberValue(input.contextWindow),
    max_output:
      input.maxOutput === undefined ? undefined : numberValue(input.maxOutput),
  });
}

function parseModelRoutes(
  value: unknown,
): Record<string, { providerKey: string; modelKey: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(
      ([tier, target]) => {
        if (!target || typeof target !== "object" || Array.isArray(target))
          return [];
        const record = target as Record<string, unknown>;
        const providerKey = stringValue(record.providerKey);
        if (!providerKey) return [];
        return [
          [tier, { providerKey, modelKey: stringValue(record.modelKey) }],
        ];
      },
    ),
  );
}

function cliStatus(value: unknown): "recognized" | "path" | "unchecked" {
  return value === "recognized" || value === "path" ? value : "unchecked";
}

/**
 * 编辑器草稿的 config.* 字段 → syncwire.AgentBackendConfig 那张键表。整个对象
 * 一起发：config 是「带则整体替换」，缺一个键就是把它悄悄清空，所以哪怕只改了
 * 其中一格,也要把这个类型用得上的全部格子重新收一遍——buildBackendDraft 已经把
 * 用不上的格子清成 ""，不会有跨类型串值。空值键按契约省略，全空即 {}。
 */
function configBody(input: Record<string, unknown>): Record<string, unknown> {
  const rawRoutes = input.modelRoutes;
  const routes =
    typeof rawRoutes === "string"
      ? (JSON.parse(rawRoutes || "{}") as unknown)
      : rawRoutes;
  const modelRoutes =
    routes && typeof routes === "object" && !Array.isArray(routes)
      ? (routes as Record<string, unknown>)
      : undefined;
  const config: Record<string, unknown> = {
    ...(modelRoutes && Object.keys(modelRoutes).length > 0
      ? { modelRoutes }
      : {}),
    sandbox: stringValue(input.sandbox),
    approval: stringValue(input.approval),
    defaultPermissionMode: stringValue(input.defaultPermissionMode),
    defaultModel: stringValue(input.defaultModel),
    openclawGatewayUrl: stringValue(input.openClawGatewayUrl),
    openclawAgentId: stringValue(input.openClawAgentId),
    openclawDefaultModel: stringValue(input.openClawDefaultModel),
    // 会话映射是桌面端 entity 的硬校验：不是 per-agentre-session 就整条判非法。
    // 漏发它等于在账号里存下一条同步下去必被拒的后端。
    openclawSessionMode: stringValue(input.openClawSessionMode),
  };
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== ""),
  );
}

/**
 * 新建：整份草稿已填好的字段照实发（规格「create 发全部已填字段」）；config
 * 只在这个类型确有独占设置时才带——扫描创建那条路只给 type/name/deviceId，
 * config 全空，服务端新建行本来就以 {} 起手（newBackendDoc），带一个全空对象
 * 上去不改变落库结果，纯属噪音。
 */
function createBackendBody(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const config = configBody(input);
  return compact({
    name: input.name,
    type: input.type,
    device_fingerprint: input.deviceId,
    provider_key: input.llmProviderKey,
    model_key: input.llmModelKey,
    // 编辑器序列化回来的整张表原样发回。缺省（compact 会剔掉 undefined）即不改，
    // 服务端据此保留存着的表——只换设备之类的保存不会顺手把它抹掉。
    env_json: input.envJson,
    reasoning_effort: input.reasoningEffort,
    config: Object.keys(config).length === 0 ? undefined : config,
    // cli_path **不进这里**：可执行文件路径走独立的 per-device cliPath 端口
    // （见 ports.cliPath.set），与桌面端 agent_backend_svc.create 同一分工——
    // 那一侧的 entity 在创建时压根不认 CLIPath 字段。
  });
}

/**
 * 编辑：只发 changedFields 点名的字段——共享编辑器把「用户这次真改过什么」算好
 * 放在 input.changedFields 里（BackendChangedField[]），顶层键逐个发，任一
 * `config.*` 命中就把 config 整个带上；device_fingerprint 是服务端每次写入的
 * 强制字段（validateBackendWrite 无条件解引用，desktop 自己的 UpdateAgentBackend
 * 同理无条件重写 DeviceFingerprint），不是「用户本次改没改」的产物,因此不看
 * changedFields、每次都带。cli_path 同 create：只走独立的 cliPath 端口，这里
 * 不发——即使 "cliPath" 出现在 changedFields 里也不理会,避免同一条覆盖被两条
 * 请求各写一次、落在不同设备上时互相打架。
 */
const TOP_LEVEL_FIELD_TO_BODY_KEY: Record<string, string> = {
  type: "type",
  name: "name",
  llmProviderKey: "provider_key",
  llmModelKey: "model_key",
  envJson: "env_json",
  reasoningEffort: "reasoning_effort",
};

function updateBackendBody(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const changedFields = Array.isArray(input.changedFields)
    ? (input.changedFields as unknown[])
    : [];
  const body: Record<string, unknown> = { device_fingerprint: input.deviceId };
  let touchesConfig = false;
  for (const field of changedFields) {
    if (typeof field !== "string") continue;
    if (field.startsWith("config.")) {
      touchesConfig = true;
      continue;
    }
    const key = TOP_LEVEL_FIELD_TO_BODY_KEY[field];
    if (key) body[key] = input[field];
  }
  if (touchesConfig) body.config = configBody(input);
  return body;
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

  /**
   * 单模型写入端点（S3）。每一个都返回整个供应商，调用方据此刷新缓存——但请求体
   * 只带这一个模型的字段，绝不带同供应商其它模型的数组（规格「模型开关」：启停/
   * 编辑单个模型只影响该模型，其它模型，含页面打开后其它设备新增或改动的，保持
   * 服务端当前值）。
   */
  async function createProviderModel(
    providerKey: string,
    fields: Record<string, unknown>,
  ): Promise<ProviderDTO> {
    const updated = await api<ProviderDTO>(
      `/v1/engine/providers/${encodeURIComponent(providerKey)}/models`,
      { method: "POST", body: JSON.stringify(fields) },
    );
    providerView(updated);
    return updated;
  }

  async function patchProviderModel(
    providerKey: string,
    modelKey: string,
    fields: Record<string, unknown>,
  ): Promise<ProviderDTO> {
    const updated = await api<ProviderDTO>(
      `/v1/engine/providers/${encodeURIComponent(providerKey)}/models/${encodeURIComponent(modelKey)}`,
      { method: "PATCH", body: JSON.stringify(fields) },
    );
    providerView(updated);
    return updated;
  }

  async function deleteProviderModel(
    providerKey: string,
    modelKey: string,
  ): Promise<ProviderDTO> {
    const updated = await api<ProviderDTO>(
      `/v1/engine/providers/${encodeURIComponent(providerKey)}/models/${encodeURIComponent(modelKey)}`,
      { method: "DELETE" },
    );
    providerView(updated);
    return updated;
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
    // 旧平铺格式的行服务端读作 {}；config 本身也可能是 JSON null（未写过）。
    // 两种情况都当「没配」，不当错误。
    const config = backend.config ?? {};
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
      modelRoutes: parseModelRoutes(config.modelRoutes),
      sandbox: config.sandbox ?? "",
      approval: config.approval ?? "",
      envJson: backend.env_json,
      reasoningEffort: backend.reasoning_effort,
      defaultPermissionMode: config.defaultPermissionMode ?? "",
      defaultModel: config.defaultModel ?? "",
      openClawGatewayUrl: config.openclawGatewayUrl ?? "",
      openClawAgentId: config.openclawAgentId ?? "",
      openClawDefaultModel: config.openclawDefaultModel ?? "",
      agentCount: backend.ref_count,
      deviceId: backend.device_fingerprint ?? "",
      // 名字查不到就留空——共享包据此渲染「设备已撤销」；空 deviceId 才是
      // 决策 14 的「未指定设备」。两者是两条不同的如实说法，不能合并。
      deviceName: deviceNames.get(backend.device_fingerprint ?? "") ?? "",
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
    supportedBackendTypes: BROWSER_BACKEND_TYPES,
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
      const updated = await patchProviderModel(
        location.providerKey,
        location.modelKey,
        { enabled },
      );
      const model = updated.models.find(
        (item) => item.model_key === location.modelKey,
      );
      if (!model) throw new Error(`Model is unavailable: ${location.modelKey}`);
      return modelView(updated, model);
    },

    async createModels(providerID, inputs) {
      const provider = await providerForID(providerID);
      const createdKeys = new Set<string>();
      let updated = provider;
      // 一次只经单模型端点新增一个：批量导入发现的模型时，同供应商其它模型
      // （含页面打开后其它设备并发加的）不该被任何一次写入带着重编一遍。
      for (const input of inputs) {
        const fields = modelBody(input as Record<string, unknown>);
        createdKeys.add(fields.model_key);
        updated = await createProviderModel(provider.provider_key, fields);
      }
      return updated.models
        .filter((model) => createdKeys.has(model.model_key))
        .map((model) => modelView(updated, model));
    },

    async updateModel(id, input) {
      const location = modelLocation.get(id);
      if (!location) throw new Error(`Unknown model: ${id}`);
      const updated = await patchProviderModel(
        location.providerKey,
        location.modelKey,
        modelPatchBody(input as Record<string, unknown>),
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
      await deleteProviderModel(location.providerKey, location.modelKey);
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
      assertSupportedBackendType(input.type, messages.unsupportedBackendReason);
      // 服务端仍是必填校验的权威（code 30904 判指纹是否还在账号内）；这里先拦一道，
      // 是为了「没选设备」这件当场就知道的事不必先发一个注定被拒的请求。
      requireDevice(input);
      const created = await api<BackendDTO>("/v1/engine/backends", {
        method: "POST",
        body: JSON.stringify(createBackendBody(input)),
      });
      backendDTOs.set(created.sync_id, created);
      const [providers] = await Promise.all([fetchProviders(), loadDevices()]);
      return backendView(created, providers);
    },

    async updateBackend(id, input) {
      assertSupportedBackendType(input.type, messages.unsupportedBackendReason);
      requireDevice(input);
      const key = backendIDs.key(id);
      const updated = await api<BackendDTO>(
        `/v1/engine/backends/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          body: JSON.stringify(updateBackendBody(input)),
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
      assertSupportedBackendType(
        stringValue(input.type) || backend?.type || "",
        messages.unsupportedBackendReason,
      );
      if (backend) {
        providerKey ||= backend.provider_key;
        modelKey ||= backend.model_key;
        deviceID ||= backend.device_fingerprint ?? "";
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

    // 探测走 cliResolvePath 而不是 engineScan：后者一次能答三个类型，但它按设计
    // 只带「装没装」，不带路径。而共享包的「自动识别」是 `r.found ? r.path : null`
    // ——回一个 found=true、path 空的结果，按钮会在 CLI 装着的时候显示「没找到」。
    // 换成每类型各拨一次，多的只是帧，连接仍是池化的同一条。
    async resolveBackendCLIPath(backendType, deviceId) {
      const device = await executionDevice(stringValue(deviceId));
      const result = await relayCall<{ path?: string; found?: boolean }>(
        device.fingerprint,
        rpcMethods.cliResolvePath,
        { type: backendType },
      );
      return { path: stringValue(result.path), found: result.found === true };
    },

    cliPath: {
      // 按 (后端, **调用方点名的设备**) 取回配过的路径——不是这条后端当前绑定
      // 的设备。编辑器换了设备但还没保存时，这里要能立刻答出新设备已存的值；
      // 判定权在调用方给的 deviceId，挑错（比如仍按 backend.device_fingerprint
      // 找）就会把旧设备的路径显示成新设备的。
      async get(backendSyncId, deviceId) {
        const overlays = await fetchCLIOverlays();
        const hit = overlays.find(
          (overlay) =>
            overlay.backend_sync_id === backendSyncId &&
            overlay.fingerprint === deviceId,
        );
        return hit ? hit.cli_path : null;
      },
      // 面板保存走的是 updateBackend，但那条路径**不带** cli_path（见
      // updateBackendBody 的注释）：可执行文件路径专走这个端口。device_fingerprint
      // 与 cli_path 必须在同一次 PATCH 里一起发——服务端 saveCLIOverlay 认的是
      // 这一次请求里的 device_fingerprint，不是这条后端存着的那个；调用方传什么
      // 设备，覆盖就落在哪台机器上。
      async set(backendSyncId, deviceId, path) {
        await api(`/v1/engine/backends/${encodeURIComponent(backendSyncId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            cli_path: path,
            device_fingerprint: deviceId,
          }),
        });
      },
    },

    async scanBackendResults(deviceId) {
      const fingerprint = stringValue(deviceId).trim();
      if (fingerprint === "") throw new Error(messages.deviceRequiredReason);
      const result = await scanDevice(fingerprint);
      const existing = await fetchBackends();
      return Promise.all(
        (result.items ?? [])
          // daemon 可能比 browser host 更新；capability 之外的类型在任何写入前忽略，
          // 避免 Promise.all 已创建一半支持项后才被 Hermes 拒绝成整次扫描失败。
          .filter((item) => BROWSER_BACKEND_TYPE_SET.has(item.backendType))
          .map(async (item) => {
            const found = item.status === "recognized";
            // 「已经有了」按 (设备, 类型) 判：同一类型在别的机器上已有后端，
            // 不构成在这台机器上跳过的理由（决策 13）。
            const current = existing.find(
              (backend) =>
                backend.type === item.backendType &&
                backend.device_fingerprint === fingerprint,
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
