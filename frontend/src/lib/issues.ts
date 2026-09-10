/**
 * 看板那一族端点（规格 2026-08-27「`agentre-server` 端」）。
 *
 * 读一条、写七条，与组织面 / 项目面走同一条通道：账号取自本组的鉴权，**请求体里
 * 没有任何身份字段**。写那七条与 `pages/org/writes.ts` 同形——建（`/…`）、改
 * （`/…/update`）、删（`/…/delete`），外加拖动自己那一条。
 *
 * 线上说的是**同步标识**（任务、标签、项目、Agent、后端一律 `sync_id`），共享呈现
 * 件说的是数字 id；两者之间的换算全在 `boardWire.ts`，这里只照搬载荷形状，不做一层
 * 只会漂开的改名。
 */
import { api } from "@/lib/api";

/** 组织面那条写响应，八条端点共用。 */
export interface OrgWriteResponse {
  sync_id: string;
  version: number;
}

/** 标签目录的一项；卡片上的标签用不到 `usage_count`，那一处它是 0。 */
export interface LabelItem {
  sync_id: string;
  name: string;
  tone: string;
  usage_count: number;
}

/**
 * 板上的一张卡。**没有 state**：状态轴本轮消失，已完成完全由 `stage` 推导。
 * 执行归属三个字段本轮没有任何路径读，但必须带出来——表单打开时那三颗 pill 要停在
 * 原来的位置上。
 */
export interface IssueItem {
  sync_id: string;
  title: string;
  description?: string;
  stage: string;
  position: number;
  /** 空 = 未归属。 */
  project_sync_id?: string;
  agent_sync_id?: string;
  agent_backend_sync_id?: string;
  llm_provider_key?: string;
  llm_model_key?: string;
  closed_at: number;
  /** 账号**第一次见到**这张卡的时刻（载荷里没有桌面端那一行的建立时间）。 */
  created_at: number;
  updated_at: number;
  labels: LabelItem[];
}

/** 项目选择器右侧那个「子树未完成数」；空 `project_sync_id` 是「未归属」那一档。 */
export interface ProjectIssueCount {
  project_sync_id: string;
  count: number;
}

export interface IssueBoardResponse {
  issues: IssueItem[];
  labels: LabelItem[];
  /** 列头的「命中」：吃全部筛选条件。 */
  stage_counts: Record<string, number>;
  /** 列头的「全部」：只吃项目范围。 */
  stage_totals: Record<string, number>;
  project_counts: ProjectIssueCount[];
  /** 当前范围覆盖到的项目——卡片要不要带项目字形靠的就是这个判据。 */
}

/** 浏览器能写的任务键，建与改共用。不传即「这次请求没提到这个键」。 */
export interface IssueFields {
  title?: string;
  description?: string;
  stage?: string;
  project_sync_id?: string;
  agent_sync_id?: string;
  agent_backend_sync_id?: string;
  llm_provider_key?: string;
  llm_model_key?: string;
  label_sync_ids?: string[];
}

/** 浏览器能写的标签键。**没有 status**：还在不在由建 / 删两条路径决定。 */
export interface IssueLabelFields {
  name?: string;
  tone?: string;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

/** 一次取回看板要画的全部材料；六个筛选条件由 `toBoardQueryString` 拼好。 */
export function fetchBoard(query: string): Promise<IssueBoardResponse> {
  return api<IssueBoardResponse>(
    query ? `/v1/workspace/issues?${query}` : "/v1/workspace/issues",
  );
}

export function createIssue(fields: IssueFields): Promise<OrgWriteResponse> {
  return post("/v1/workspace/issues", fields);
}

export function updateIssue(
  syncId: string,
  fields: IssueFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/issues/update", { sync_id: syncId, ...fields });
}

/**
 * 拖一张卡：落到哪一列、排在谁后面（`afterSyncId` 为空即列首）。位置由服务端在相邻
 * 两卡之间算——交给浏览器算的话，两个标签页同时拖就会算出两个互相覆盖的值。
 */
export function moveIssue(
  syncId: string,
  stage: string,
  afterSyncId: string,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/issues/move", {
    sync_id: syncId,
    stage,
    after_sync_id: afterSyncId,
  });
}

export function deleteIssue(syncId: string): Promise<OrgWriteResponse> {
  return post("/v1/workspace/issues/delete", { sync_id: syncId });
}

export function createIssueLabel(
  fields: IssueLabelFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/issues/labels", fields);
}

export function updateIssueLabel(
  syncId: string,
  fields: IssueLabelFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/issues/labels/update", {
    sync_id: syncId,
    ...fields,
  });
}

export function deleteIssueLabel(syncId: string): Promise<OrgWriteResponse> {
  return post("/v1/workspace/issues/labels/delete", { sync_id: syncId });
}
