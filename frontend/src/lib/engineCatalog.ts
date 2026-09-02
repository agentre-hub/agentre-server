import type { PickerProvider } from "@agentre-hub/agentre-ui";
import { useState } from "react";

import { useAliveEffect } from "@/hooks/use-api-query";
import { api } from "@/lib/api";

/**
 * 账号侧的引擎目录（供应商 + Agent 后端），以及把它翻成模型选择器认得的形状。
 *
 * 包里也有一对 `buildPickerCatalog` / `useModelTargetCatalog`，但那两个够不着这一
 * 端：它们经 `port-bridge` 依赖桌面端 Wails 生成的 `llm_provider_svc` DTO。本站的
 * 目录来自 REST，形状不同，所以映射留在宿主 —— 这正是「宿主保留自己的适配层」
 * 那条分工。真正共享的是**推导**（`resolveProviderPillState`）与呈现件。
 */

/** GET /v1/engine/providers 的一行。 */
export interface EngineProvider {
  provider_key: string;
  name: string;
  /** 供应商类型（anthropic / openai / …）。选择器按它过滤与后端不兼容的供应商。 */
  type: string;
  default_model_key: string;
  enabled: boolean;
  models: {
    model_key: string;
    model_id?: string;
    name: string;
    enabled: boolean;
    context_window?: number;
    max_output?: number;
  }[];
}

/** GET /v1/engine/backends 的一行：Agent 后端绑定的供应商 / 模型 / 默认档位。 */
export interface EngineBackend {
  sync_id: string;
  provider_key: string;
  model_key: string;
  default_permission_mode: string;
  /**
   * 这个后端配的思考力度（六档，空 = 没配）。会话没自己钉一档时，composer 那颗
   * 力度控件用它兜底显示「→ 跟随后端配置 · <档位>」。
   *
   * 可选：老应答里没有这一格（`internal/api/engine.BackendItem` 是后加的），缺席
   * 与「配的是空」在界面上是同一句话（跟随后端配置 · 未设定）。
   */
  reasoning_effort?: string;
}

/**
 * 目录映射。停用的供应商与模型照旧交出去，由选择器自己置灰并说明 —— 悄悄滤掉
 * 会让用户看不见「我钉的那个东西被停用了」。
 */
export function toPickerCatalog(providers: EngineProvider[]): PickerProvider[] {
  return providers.map((provider, index) => {
    const models = provider.models.map((m) => ({
      modelKey: m.model_key,
      // model_id 缺席时退回 key：脸上宁可写一串引用键，也不写空。
      modelId: m.model_id ?? m.model_key,
      name: m.name,
      enabled: m.enabled,
      contextWindow: m.context_window,
      maxOutput: m.max_output,
    }));
    return {
      providerKey: provider.provider_key,
      id: index + 1,
      name: provider.name,
      type: provider.type,
      enabled: provider.enabled,
      defaultModel:
        models.find((m) => m.modelKey === provider.default_model_key) ?? null,
      models,
    };
  });
}

export interface EngineCatalogState {
  providers: EngineProvider[];
  backends: EngineBackend[];
  catalog: PickerProvider[];
}

/**
 * 取一次账号侧的引擎目录。取不到就空着：模型控件会退回「还不知道」那一态
 * （什么都不写），而不是编一个目录出来。
 */
export function useEngineCatalog(): EngineCatalogState {
  const [providers, setProviders] = useState<EngineProvider[]>([]);
  const [backends, setBackends] = useState<EngineBackend[]>([]);
  useAliveEffect((alive) => {
    void Promise.all([
      api<{ providers?: EngineProvider[] }>("/v1/engine/providers"),
      api<{ backends?: EngineBackend[] }>("/v1/engine/backends"),
    ])
      .then(([providerResult, backendResult]) => {
        if (!alive()) return;
        setProviders(providerResult.providers ?? []);
        setBackends(backendResult.backends ?? []);
      })
      .catch(() => {});
  }, []);
  return { providers, backends, catalog: toPickerCatalog(providers) };
}
