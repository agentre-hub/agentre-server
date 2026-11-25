/**
 * 项目面的读写端点（规格 2026-08-20）。
 *
 * 写方向与组织面那九个同一种形状（见 `pages/org/writes.ts`）：每族三个 POST
 * （建 / `/update` / `/delete`），字段一律可选、指针语义——**不传 = 「这次请求没提到
 * 这个键」**，服务端只覆盖明确涉及的键。项目设置是即时保存，每次 blur 只提交改动的
 * 那一个字段，这条约定因此比别处更吃紧。
 *
 * 路径那一族是例外，只有「设」与「删」：账号内自然键是（项目同步标识, 指纹），
 * 服务端按它先找存活的那一行，有就改、没有就建，因此调用方不需要知道这次是哪一种。
 */
import { AccountChannelSyncVersion } from "@agentre-hub/agentre-wire";

import { api, ApiTimeoutError } from "@/lib/api";
import { createRoster } from "@/lib/rosterFetch";

export interface OrgWriteResponse {
  sync_id: string;
  version: number;
}

/** 项目的一个直接成员：`syncId` 是**这条成员关系自己的**标识，删成员按它定位。 */
export interface ProjectMember {
  syncId: string;
  agentSyncId: string;
}

export interface ProjectNode {
  syncId: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  parentSyncId: string;
  sortOrder: number;
  /** 至少有一台 agentred 配了这个项目的路径。判据在服务端（决策 9）。 */
  configured: boolean;
  members: ProjectMember[];
}

/**
 * 项目设置「机器与路径」那一节的一行。
 *
 * `path` 只有 agentred 才有正文，**桌面端恒为空**：它的本机路径住在上报组、
 * 整份快照替换，从 web 写一行进去下次上报就被冲掉（决策 4）。`locationSyncId` 同理
 * ——桌面端没有可删的那一行。
 */
export interface ProjectMachine {
  deviceId: number;
  deviceName: string;
  kind: string;
  /** 目录选择器靠它拨中继。 */
  fingerprint: string;
  online: boolean;
  configured: boolean;
  path: string;
  locationSyncId: string;
}

/** 浏览器能写的项目键。不传即不改。 */
export interface ProjectFields {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  parent_sync_id?: string;
  sort_order?: number;
}

/**
 * 项目面的每一个写都从这里过，所以项目树的作废也只写在这里。失败也作废：请求可能
 * 已经写进去了，只是应答没回来。
 */
function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) }).finally(
    () => projectRoster.invalidate(),
  );
}

// ---------- 项目树 ----------

export async function fetchProjects(): Promise<ProjectNode[]> {
  const data = await api<{
    projects?: {
      sync_id: string;
      name: string;
      icon?: string;
      color?: string;
      description?: string;
      parent_sync_id?: string;
      sort_order?: number;
      configured?: boolean;
      members?: { sync_id: string; agent_sync_id: string }[];
    }[];
  }>("/v1/workspace/projects");
  return (data.projects ?? []).map((p) => ({
    syncId: p.sync_id,
    name: p.name,
    icon: p.icon ?? "",
    color: p.color ?? "",
    description: p.description ?? "",
    parentSyncId: p.parent_sync_id ?? "",
    sortOrder: p.sort_order ?? 0,
    configured: p.configured === true,
    members: (p.members ?? []).map((m) => ({
      syncId: m.sync_id,
      agentSyncId: m.agent_sync_id,
    })),
  }));
}

/**
 * 共享的那一份项目树（`@/lib/rosterFetch`）：对话页与详情同一屏上共用一个在飞请求、
 * 10 秒内复用。同步版本推进与本文件里的每一个写作废它。
 */
export const projectRoster = createRoster(
  fetchProjects,
  [AccountChannelSyncVersion],
  "roster-projects",
);

/**
 * 新建超时（F5）后，重读也没能确认：`checked` 为假 = 连重读都失败了，项目可能已经建好；
 * 为真 = 重读了、没找到，可以再提交。文案由 `projectFailureText` 按它说。
 */
export class ProjectCreateTimeoutError extends Error {
  constructor(public checked: boolean) {
    super("project create timed out");
    this.name = "ProjectCreateTimeoutError";
  }
}

/** 在重读的整份名单里认出「刚提交的那个」：提交前没见过 + 名称、上级一致，取靠后的一条。 */
export function findCreatedProject(
  projects: ProjectNode[],
  submitted: ProjectFields,
  knownBefore: ReadonlySet<string>,
): ProjectNode | null {
  const matches = projects.filter(
    (p) =>
      !knownBefore.has(p.syncId) &&
      p.name.trim() === (submitted.name ?? "").trim() &&
      p.parentSyncId === (submitted.parent_sync_id ?? ""),
  );
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * 建项目。POST 超时时请求可能已经写进去了：重读整份名单（不带任何筛选）认出新的那个，
 * 认出就当作建成（调用方照常打开它）；认不出抛 `ProjectCreateTimeoutError`。
 *
 * 「提交前」的基线取共享名单（在飞就共用、10 秒内复用）且**与 POST 同时发出、不等它**，
 * 创建不会被基线拖慢；基线取不到时不敢认（否则同名旧项目会被认错），按「没核实」报。
 */
export async function createProject(
  fields: ProjectFields,
): Promise<OrgWriteResponse> {
  const baseline = projectRoster.get().then(
    (rows) => new Set(rows.map((p) => p.syncId)) as ReadonlySet<string>,
    () => null,
  );
  try {
    return await post<OrgWriteResponse>("/v1/workspace/org/projects", fields);
  } catch (err) {
    if (!(err instanceof ApiTimeoutError)) throw err;
    const known = await baseline;
    if (!known) throw new ProjectCreateTimeoutError(false);
    try {
      const found = findCreatedProject(await fetchProjects(), fields, known);
      if (found) return { sync_id: found.syncId, version: 0 };
    } catch {
      throw new ProjectCreateTimeoutError(false);
    }
    throw new ProjectCreateTimeoutError(true);
  }
}

export function updateProject(
  syncId: string,
  fields: ProjectFields,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/projects/update", {
    sync_id: syncId,
    ...fields,
  });
}

export function deleteProject(syncId: string): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/projects/delete", { sync_id: syncId });
}

// ---------- 成员 ----------
//
// 只有加与删，没有改：一条成员关系要么在、要么不在。

export function addProjectMember(
  projectSyncId: string,
  agentSyncId: string,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/project-members", {
    project_sync_id: projectSyncId,
    agent_sync_id: agentSyncId,
  });
}

/** 删的是**这条成员关系**那一行，不是 Agent：同一个 Agent 可以在好几个项目里。 */
export function removeProjectMember(syncId: string): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/project-members/delete", { sync_id: syncId });
}

// ---------- 机器与路径 ----------

export async function fetchProjectMachines(
  projectSyncId: string,
): Promise<ProjectMachine[]> {
  const data = await api<{
    machines?: {
      device_id: number;
      device_name: string;
      kind: string;
      fingerprint: string;
      online?: boolean;
      configured?: boolean;
      path?: string;
      location_sync_id?: string;
    }[];
  }>(
    `/v1/workspace/projects/machines?project_sync_id=${encodeURIComponent(projectSyncId)}`,
  );
  return (data.machines ?? []).map((m) => ({
    deviceId: m.device_id,
    deviceName: m.device_name,
    kind: m.kind,
    fingerprint: m.fingerprint,
    online: m.online === true,
    configured: m.configured === true,
    path: m.path ?? "",
    locationSyncId: m.location_sync_id ?? "",
  }));
}

export function setProjectLocation(
  projectSyncId: string,
  deviceFingerprint: string,
  path: string,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/project-locations", {
    project_sync_id: projectSyncId,
    device_fingerprint: deviceFingerprint,
    path,
  });
}

export function deleteProjectLocation(
  syncId: string,
): Promise<OrgWriteResponse> {
  return post("/v1/workspace/org/project-locations/delete", {
    sync_id: syncId,
  });
}

/** 一棵子树下有几个项目（不含它自己）。删除确认要把这个数说出来。 */
export function descendantCount(
  projects: ProjectNode[],
  rootSyncId: string,
): number {
  const childrenOf = new Map<string, string[]>();
  for (const p of projects) {
    if (!p.parentSyncId) continue;
    childrenOf.set(p.parentSyncId, [
      ...(childrenOf.get(p.parentSyncId) ?? []),
      p.syncId,
    ]);
  }
  const seen = new Set<string>([rootSyncId]);
  const queue = [rootSyncId];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()!) ?? []) {
      // 数据里已经有环时不该跟着转不出来。
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen.size - 1;
}
