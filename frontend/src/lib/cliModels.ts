import type { CliModelCatalog } from "@agentre-hub/agentre-ui";
import { rpcMethods } from "@agentre-hub/agentre-wire";

import { api } from "@/lib/api";
import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

/** 查询 CLI 自带模型列表所需的后端字段（同步后端 DTO 的子集）。 */
export interface CLIModelsBackend {
  sync_id: string;
  type: string;
  env_json: string;
  reasoning_effort: string;
  config: { defaultPermissionMode?: string } | null;
  /** 供应商绑定：只参与缓存失效（规格「绑定」变化使缓存失效），不随查询过线。 */
  provider_key?: string;
  model_key?: string;
}

type CLIModelsResponse = {
  models?: Array<{
    value: string;
    displayName: string;
    modelId: string;
    group: string;
    legacy: boolean;
  }>;
  effectiveValue?: string;
  effectiveModelId?: string;
};

// 仅内存，键 `fingerprint|sync_id`；不落盘。refresh 绕过并覆盖，失败不写入。
// 每格同时记下问它时的配置（查询入参 + 绑定）：配置变了就当没命中，与桌面端
// agent_backend_svc.ListCLIModels 按配置指纹失效同一条。
const cache = new Map<string, { config: string; catalog: CliModelCatalog }>();

/** 清空目录缓存（测试用）。 */
export function resetCLIModelsCache(): void {
  cache.clear();
}

/**
 * 这条后端在 `fingerprint` 那台设备上配过的 CLI 可执行文件路径（per-device 覆盖）；
 * 没配就是空串，由 CLI 按 PATH 找。读不出来时**原样抛出**：把「读失败」当成「没配」
 * 会让目录问到 PATH 上随便哪一个 CLI，与桌面端 agent_backend_svc.ListCLIModels 同一条。
 */
export async function cliOverlayPath(
  fingerprint: string,
  backendSyncId: string,
): Promise<string> {
  const response = await api<{
    overlays?: {
      backend_sync_id: string;
      fingerprint: string;
      cli_path: string;
    }[];
  }>("/v1/engine/cli-overlays");
  const overlay = (response.overlays ?? []).find(
    (o) => o.backend_sync_id === backendSyncId && o.fingerprint === fingerprint,
  );
  return overlay?.cli_path ?? "";
}

/**
 * 经中继向 `fingerprint` 这台设备查询后端的 CLI 自带模型目录。
 * 设备在线与否由调用方先判；中继错误原样抛出。
 */
export async function listCLIModelsOn(
  fingerprint: string,
  backend: CLIModelsBackend,
  { refresh }: { refresh: boolean },
  cliPath: string,
): Promise<CliModelCatalog> {
  const key = `${fingerprint}|${backend.sync_id}`;
  const request = {
    backendType: backend.type,
    cliPath,
    envJson: backend.env_json,
    defaultPermissionMode: backend.config?.defaultPermissionMode ?? "",
    reasoningEffort: backend.reasoning_effort,
  };
  const config = JSON.stringify([
    request,
    backend.provider_key ?? "",
    backend.model_key ?? "",
  ]);
  if (!refresh) {
    const hit = cache.get(key);
    if (hit && hit.config === config) return hit.catalog;
  }
  const response = (await withRelayClient(
    machineTarget(fingerprint),
    async (client) =>
      (await client.request(
        rpcMethods.cliModelsList,
        request,
      )) as CLIModelsResponse,
  )) as CLIModelsResponse;
  const catalog: CliModelCatalog = {
    models: (response.models ?? []).map((model) => ({
      value: model.value,
      label: model.displayName,
      modelId: model.modelId,
      group: model.group,
      legacy: model.legacy,
    })),
    effectiveValue: response.effectiveValue,
    effectiveModelId: response.effectiveModelId,
  };
  cache.set(key, { config, catalog });
  return catalog;
}
