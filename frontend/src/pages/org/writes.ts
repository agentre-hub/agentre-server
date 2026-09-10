/**
 * 九个写端点（commit aee3a85）+ 既有的执行目标账号级排序端点。每一族三个：建
 * （POST `/…`）、改（POST `/…/update`）、删（POST `/…/delete`）——都是 POST，
 * 与隔壁 `/v1/saved-sessions` 那一族同一种形状。
 *
 * 字段一律可选（指针语义）：不传 = 「这次请求没提到这个键」，服务端只覆盖明确
 * 涉及的键。这里的函数签名原样保留这个约定——调用方只填自己改动的字段。
 */
import { api } from "@/lib/api";

import type {
  AgentFields,
  DepartmentFields,
  ExecTargetFields,
  OrgWriteResponse,
} from "./types";

function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
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
