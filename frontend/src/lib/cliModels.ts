import type { CliModelCatalog } from "@agentre-hub/agentre-ui";
import { rpcMethods } from "@agentre-hub/agentre-wire";

import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

/** 查询 CLI 自带模型列表所需的后端字段（同步后端 DTO 的子集）。 */
export interface CLIModelsBackend {
  sync_id: string;
  type: string;
  env_json: string;
  reasoning_effort: string;
  config: { defaultPermissionMode?: string } | null;
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
const cache = new Map<string, CliModelCatalog>();

/** 清空目录缓存（测试与账号切换用）。 */
export function resetCLIModelsCache(): void {
  cache.clear();
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
  if (!refresh) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const response = (await withRelayClient(
    machineTarget(fingerprint),
    async (client) =>
      (await client.request(rpcMethods.cliModelsList, {
        backendType: backend.type,
        cliPath,
        envJson: backend.env_json,
        defaultPermissionMode: backend.config?.defaultPermissionMode ?? "",
        reasoningEffort: backend.reasoning_effort,
      })) as CLIModelsResponse,
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
  cache.set(key, catalog);
  return catalog;
}
