/**
 * 九个写端点（commit aee3a85）+ 既有的执行目标账号级排序端点。每一族三个：建
 * （POST `/…`）、改（POST `/…/update`）、删（POST `/…/delete`）——都是 POST，
 * 与隔壁 `/v1/saved-sessions` 那一族同一种形状。
 *
 * 字段一律可选（指针语义）：不传 = 「这次请求没提到这个键」，服务端只覆盖明确
 * 涉及的键。这里的函数签名原样保留这个约定——调用方只填自己改动的字段。
 */
import { agentRoster } from "@/lib/agents";
import { api } from "@/lib/api";

import type {
  AgentFields,
  DepartmentFields,
  ExecTargetFields,
  OrgAgentItem,
  OrgChartResponse,
  OrgDepartmentItem,
  OrgWriteResponse,
} from "./types";

/**
 * 组织面的每一个写都从这里过。共享的 Agent 名单（`@/lib/agents` 的 agentRoster）带着
 * 部门名与执行目标，三族写都让它过期——失败也作废：请求可能已经写进去了，只是应答
 * 没回来。
 */
function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) }).finally(
    () => agentRoster.invalidate(),
  );
}

// ---------- 部门 ----------

export function createDepartment(
  fields: DepartmentFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/departments", fields);
}

export function updateDepartment(
  syncId: string,
  fields: DepartmentFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/departments/update", {
    sync_id: syncId,
    ...fields,
  });
}

export function deleteDepartment(syncId: string): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/departments/delete", { sync_id: syncId });
}

// ---------- Agent ----------

export function createAgent(fields: AgentFields): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/agents", fields);
}

export function updateAgent(
  syncId: string,
  fields: AgentFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/agents/update", {
    sync_id: syncId,
    ...fields,
  });
}

export function deleteAgent(syncId: string): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/agents/delete", { sync_id: syncId });
}

// ---------- 执行目标 ----------

export function createExecTarget(
  fields: ExecTargetFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/exec-targets", fields);
}

export function updateExecTarget(
  syncId: string,
  fields: ExecTargetFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/exec-targets/update", {
    sync_id: syncId,
    ...fields,
  });
}

export function deleteExecTarget(syncId: string): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/exec-targets/delete", { sync_id: syncId });
}

// ---------- 新建超时后认「刚提交的那条」（规格 F5）----------

/**
 * 多条同时符合时取最新的：这两份读里没有 created_at，新建的排在同级末尾，
 * 所以 sort_order 大者新，相同取靠后的那条。
 */
function newest<T extends { sort_order: number }>(rows: T[]): T | null {
  return rows.reduce<T | null>(
    (a, b) => (a && a.sort_order > b.sort_order ? a : b),
    null,
  );
}

/**
 * 判据是「提交前名单里没有这个 sync_id」+ 提交的字段一致，不看时间（服务端钟与浏览器钟
 * 有偏差）；提交前就在的同名旧条目因此不会被认错。名单是整份、不带任何筛选（筛选在
 * 前端内存里做，读接口没有筛选参数）。
 */
export function findCreatedAgent(
  chart: OrgChartResponse,
  submitted: AgentFields,
  knownBefore: ReadonlySet<string>,
): OrgAgentItem | null {
  return newest(
    chart.agents.filter(
      (a) =>
        !knownBefore.has(a.sync_id) &&
        a.name.trim() === (submitted.name ?? "").trim() &&
        (a.department_sync_id ?? "") === (submitted.department_sync_id ?? ""),
    ),
  );
}

export function findCreatedDepartment(
  chart: OrgChartResponse,
  submitted: DepartmentFields,
  knownBefore: ReadonlySet<string>,
): OrgDepartmentItem | null {
  return newest(
    chart.departments.filter(
      (d) =>
        !knownBefore.has(d.sync_id) &&
        d.name.trim() === (submitted.name ?? "").trim() &&
        (d.parent_sync_id ?? "") === (submitted.parent_sync_id ?? ""),
    ),
  );
}
