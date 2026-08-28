/**
 * sync_id（字符串） ↔ 共享包要的数字 id 的桥。
 *
 * `@agentre-hub/agentre-ui` 的组织呈现件（`buildOrgIndex` / `OrgAgentRow` /
 * `OrgPlacementField` 等）全部按数字 `id` 设计——那是桌面端 Wails 行的真实数据库
 * 自增 id，`0` 表示「无」。server 这一侧的组织行只有账号级同步标识
 * `sync_id: string`，两者结构上不兼容。
 *
 * 桥的做法：**每一次响应快照各自分配一套连续正整数**（按数组下标 + 1），只在这一份
 * 快照的生命周期内有效——选中态因此不按数字 id 持有（刷新后同一行的数字 id 可能
 * 变化），而是按 sync_id 持有，展示前才经 `agentSyncOf`/`agentIdOf` 转换一次。
 */
import {
  isOrgSystemAgent,
  type OrgAgentModel,
  type OrgDepartmentModel,
  type OrgIndexRow,
} from "@agentre-hub/agentre-ui";

import type {
  OrgAgentItem,
  OrgChartResponse,
  OrgDepartmentItem,
} from "./types";

export interface OrgIdMaps {
  agentIdOf(syncId: string | undefined): number;
  deptIdOf(syncId: string | undefined): number;
  agentSyncOf(id: number): string;
  deptSyncOf(id: number): string;
}

function buildBijection(syncIds: string[]): {
  idOf: (syncId: string | undefined) => number;
  syncOf: (id: number) => string;
} {
  const toId = new Map<string, number>();
  const toSync = new Map<number, string>();
  syncIds.forEach((syncId, index) => {
    const id = index + 1;
    toId.set(syncId, id);
    toSync.set(id, syncId);
  });
  return {
    idOf: (syncId) => (syncId ? (toId.get(syncId) ?? 0) : 0),
    syncOf: (id) => (id > 0 ? (toSync.get(id) ?? "") : ""),
  };
}

export function buildOrgIdMaps(
  departments: OrgDepartmentItem[],
  agents: OrgAgentItem[],
): OrgIdMaps {
  const dept = buildBijection(departments.map((d) => d.sync_id));
  const agent = buildBijection(agents.map((a) => a.sync_id));
  return {
    agentIdOf: agent.idOf,
    deptIdOf: dept.idOf,
    agentSyncOf: agent.syncOf,
    deptSyncOf: dept.syncOf,
  };
}

export interface OrgModels {
  maps: OrgIdMaps;
  departments: OrgDepartmentModel[];
  agents: OrgAgentModel[];
  /** sync_id → 原始行：拿去建表单初值、恢复选中、拼写请求体，都从这里取。 */
  agentBySync: Map<string, OrgAgentItem>;
  departmentBySync: Map<string, OrgDepartmentItem>;
}

/**
 * 行尾那枚机器名徽标读哪一档：**第一档（rank ①）**，不是 `current` 的那一档。
 *
 * 判据是与桌面端对齐。桌面端 `AgentItem.backend` 取的是 `a.AgentBackendID` 的摘要
 * （`department_svc/department.go:197`），而那个字段是 `ExecTargets[0]` 的镜像
 * （同包 `types.go:74` 的注释写死了这一条）——也就是 ①，与可用性无关。
 *
 * `current` 是另一件事：服务端把它定义为「按顺序取第一个**可用**的会落到哪一档」
 * （`workspace_svc/workspace.go:1266`），一档都不可用时**全为 false**。拿它当徽标
 * 来源，一个明明配了三档目标、只是机器都离线的 Agent 行尾就空成一片——而在包里，
 * 「宿主没喂」与「真的没有」长得一模一样，正是 `noExecTarget` 那段注释要避开的歧义。
 * 索引这一栏要回答的是「这个 Agent 归谁跑」，不是「此刻跑不跑得动」（后者在详情里
 * 逐档标 availability），所以取 ①。
 *
 * `exec_targets` 已按 rank 升序（服务端 `Rank: i + 1`，`workspace.go:599`），取 `[0]`
 * 即 ①。取不到机器名（后端行没名字）就不喂——宁可不画，也不画一个空徽标。
 */
function primaryBackendOf(a: OrgAgentItem): { name: string } | undefined {
  const name = a.exec_targets?.[0]?.backend_name;
  return name ? { name } : undefined;
}

/** 把一份 GET /v1/workspace/org 响应拍成共享包认得的模型（数字 id）+ 一份原始行索引。 */
export function buildOrgModels(chart: OrgChartResponse): OrgModels {
  const maps = buildOrgIdMaps(chart.departments, chart.agents);
  const agentBySync = new Map(chart.agents.map((a) => [a.sync_id, a]));
  const departmentBySync = new Map(
    chart.departments.map((d) => [d.sync_id, d]),
  );

  const memberCountOf = new Map<string, number>();
  for (const a of chart.agents) {
    if (!a.department_sync_id) continue;
    memberCountOf.set(
      a.department_sync_id,
      (memberCountOf.get(a.department_sync_id) ?? 0) + 1,
    );
  }

  const departments: OrgDepartmentModel[] = chart.departments.map((d) => ({
    id: maps.deptIdOf(d.sync_id),
    name: d.name,
    description: d.description,
    icon: d.icon,
    accentColor: d.accent_color,
    parentId: maps.deptIdOf(d.parent_sync_id),
    leadAgentId: maps.agentIdOf(d.lead_agent_sync_id),
    leadAgentName: d.lead_agent_sync_id
      ? agentBySync.get(d.lead_agent_sync_id)?.name
      : undefined,
    sortOrder: d.sort_order,
    memberCount: memberCountOf.get(d.sync_id) ?? 0,
  }));

  const agents: OrgAgentModel[] = chart.agents.map((a) => ({
    id: maps.agentIdOf(a.sync_id),
    name: a.name,
    description: a.description,
    avatarColor: a.avatar_color,
    avatarIcon: a.avatar_icon,
    systemBadge: a.system_badge,
    departmentId: maps.deptIdOf(a.department_sync_id),
    parentAgentId: maps.agentIdOf(a.parent_agent_sync_id),
    parentAgentName: a.parent_agent_sync_id
      ? agentBySync.get(a.parent_agent_sync_id)?.name
      : undefined,
    sortOrder: a.sort_order,
    backend: primaryBackendOf(a),
    // 「一档都没有」是宿主算的，不由包从 backend 缺席反推（共享包 types.ts 的
    // noExecTarget 那段注释）。与桌面端逐字同一条：只在**真的收到了一个空列表**
    // 时才说没有——响应里根本没这个键（旧服务端、被裁过的载荷）不是「没有」。
    noExecTarget: Array.isArray(a.exec_targets) && a.exec_targets.length === 0,
  }));

  return { maps, departments, agents, agentBySync, departmentBySync };
}

export { isOrgSystemAgent };

/**
 * 索引工具条的「按后端」筛选留在宿主（包的 `ui/` 里没有 DropdownMenu），语义也因此
 * 不走共享包的单值 `OrgIndexFilters.backendId`——一个 Agent 现在可能挂着多档执行
 * 目标、指向不同后端，单值字段表达不了「任意一档匹配」。这里在 buildOrgIndex 的
 * 投影结果之上再筛一层：只砍 rows 的可见性，不碰 buildOrgIndex 已经算好的桶/树结构。
 */
export function filterRowsByBackend(
  rows: OrgIndexRow[],
  backendSyncId: string,
  agentBySync: Map<string, OrgAgentItem>,
  maps: OrgIdMaps,
): OrgIndexRow[] {
  if (!backendSyncId) return rows;
  return rows.filter((row) => {
    const raw = agentBySync.get(maps.agentSyncOf(row.agent.id));
    return (raw?.exec_targets ?? []).some(
      (t) => t.backend_sync_id === backendSyncId,
    );
  });
}

// ---------- prompt_json：桌面端的 string[]（按行拆分），这一侧只搬运/编辑，不建模型 ----------

/** 解不出来（空 / 非法 JSON / 不是字符串数组）时给空文本，不抛错——编辑器要能照常打开。 */
export function parsePromptJSON(json: string | undefined): string {
  if (!json) return "";
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return "";
    return parsed
      .filter((line): line is string => typeof line === "string")
      .join("\n");
  } catch {
    return "";
  }
}

/** 空行过滤与桌面端 `prompt.split("\n").filter(...)` 同规则,两端存出来的形状一致。 */
export function stringifyPromptJSON(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return JSON.stringify(lines);
}

// ---------- tools_json：{key,enabled}[]，与共享包 OrgAgentTool 同形 ----------

export interface OrgAgentToolLike {
  key: string;
  enabled: boolean;
}

export function parseToolsJSON(json: string | undefined): OrgAgentToolLike[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is OrgAgentToolLike =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { key?: unknown }).key === "string" &&
        typeof (item as { enabled?: unknown }).enabled === "boolean",
    );
  } catch {
    return [];
  }
}

export function stringifyToolsJSON(tools: OrgAgentToolLike[]): string {
  return JSON.stringify(tools);
}
