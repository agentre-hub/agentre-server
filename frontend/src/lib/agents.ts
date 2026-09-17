import { api } from "@/lib/api";
import type { NewConvAgent } from "@/components/session/newconv/types";

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
