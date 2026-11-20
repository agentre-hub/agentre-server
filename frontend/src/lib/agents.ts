import { AccountChannelSyncVersion } from "@agentre-hub/agentre-wire";

import { api } from "@/lib/api";
import type { NewConvAgent } from "@/components/session/newconv/types";
import { createRoster } from "@/lib/rosterFetch";

/**
 * 取账号下的 Agent 名单。
 *
 * 这是前端唯一直接打 `/v1/workspace/agents` 的地方。此前新对话页、看板页、总览页
 * 各自 `api<{ agents: … }>` 写一遍，路径与「缺席即空」这条口径跟着各抄一份。
 *
 * 响应形状按调用方开的洞泛型开放：新对话与看板要 NewConvAgent（默认），总览只要
 * 它自己那几列（department_name + 执行目标档位）。默认值让最常见的调用方免写泛型。
 */
export async function fetchAgents<T = NewConvAgent>(): Promise<T[]> {
  const got = await api<{ agents?: T[] }>("/v1/workspace/agents");
  return got.agents ?? [];
}

const agentList = createRoster(
  () => fetchAgents<unknown>(),
  [AccountChannelSyncVersion],
);

/**
 * 共享的那一份 Agent 名单（`@/lib/rosterFetch`）：对话页与详情同一屏上共用一个在飞
 * 请求、10 秒内复用。同步版本推进（sync_objects 变了）作废它。
 *
 * 缓存里存的是线上载荷原样，取用时按调用方的形状收窄——与 fetchAgents 的泛型同一种
 * 约定：响应形状由调用方声明，这一层不校验。
 */
export const agentRoster = {
  get: <T = NewConvAgent>(): Promise<T[]> => agentList.get() as Promise<T[]>,
  invalidate: (): void => agentList.invalidate(),
};
