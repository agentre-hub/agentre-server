/**
 * 组织索引的「待配置」判据：一个 Agent 一条可用的执行目标都没有，就是不能对话。
 *
 * 数据与「新对话」选择器同源——`exec_targets[].availability` 是服务端同一个
 * placer 算的，所以「没有任何一档 available」等价于那边的 `has_available_target`
 * 为假；原因文案也直接复用 `targetSummary`，不另造一套。
 */
import type { OrgIdMaps } from "./adapter";
import { targetSummary } from "@/components/session/newconv/types";
import type { OrgAgentItem } from "./types";

/** agentId（数字，与共享包模型同一套）→ 简短原因；能对话的 Agent 不在表里。 */
export function orgNeedsSetupReasons(
  agents: OrgAgentItem[],
  maps: OrgIdMaps,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Map<number, string> {
  const reasons = new Map<number, string>();
  for (const agent of agents) {
    if (agent.exec_targets.some((x) => x.availability === "available")) {
      continue;
    }
    reasons.set(
      maps.agentIdOf(agent.sync_id),
      targetSummary(
        {
          sync_id: agent.sync_id,
          name: agent.name,
          has_available_target: false,
          exec_targets: agent.exec_targets,
        },
        t,
      ),
    );
  }
  return reasons;
}
