/**
 * server 组织面的 REST 契约（浏览器这一侧的镜像）。
 *
 * 与 `internal/api/workspace/org.go` / `org_read.go` 逐字段对应 —— 那两个文件才是
 * 单一事实源，这里只是给前端一份类型。**任何一个类型都不带 cli_path / env_json**：
 * 这是服务端的结构性红线（R19），这一侧只是如实照抄字段集合，不是另开一道守法。
 */

// ---------- 读：GET /v1/workspace/org ----------

export interface OrgDepartmentItem {
  sync_id: string;
  name: string;
  description?: string;
  icon?: string;
  accent_color?: string;
  parent_sync_id?: string;
  lead_agent_sync_id?: string;
  sort_order: number;
}

/**
 * 服务端 workspace_svc 的取值（AvailabilityAvailable 等常量）。
 *
 * `no_device` 是空指纹那一档「未指定设备」：空指纹不再被读成「本机」，也不再复用
 * 已删除的 skipped_for_web（规格 2026-08-21 决策 14）。org 面的形态与文案本轮不变，
 * 映射不到的取值沿用 OrgExecTargetSection 既有的 statusOf 兜底；`lib/execOrder.ts`
 * 的 isMovableTier 也已经改按 `no_device` 把这一档钉在原位。
 */
export type OrgExecTargetAvailability =
  "available" | "offline" | "unpaired" | "no_device";

export interface OrgExecTargetItem {
  sync_id: string;
  rank: number;
  backend_sync_id?: string;
  backend_name?: string;
  backend_type?: string;
  device_id?: number;
  device_name?: string;
  /**
   * 这一档所在那台机器的 agentred 指纹。中继的目标是逐通道声明的（决策 10），
   * 机器作用域的操作声明 `machine:<fingerprint>`（认指纹，不认 device_id），
   * 技能选择器靠它开一条通道到那台机器问「这个后端上装了哪些技能包」。
   *
   * 本机相对引用与「后端已不在」的档没有它：浏览器语境下没有指代对象 / 不知道是
   * 哪台机器（Go 侧 `OrgExecTargetItem.DeviceFingerprint` 的注释是事实源）。
   */
  device_fingerprint?: string;
  is_local_reference: boolean;
  availability: OrgExecTargetAvailability;
  current: boolean;
  skills_json?: string;
}

export interface OrgAgentItem {
  sync_id: string;
  name: string;
  description?: string;
  avatar_color?: string;
  avatar_icon?: string;
  system_badge?: string;
  department_sync_id?: string;
  parent_agent_sync_id?: string;
  sort_order: number;
  prompt_json?: string;
  tools_json?: string;
  exec_targets: OrgExecTargetItem[];
}

export interface OrgChartResponse {
  departments: OrgDepartmentItem[];
  agents: OrgAgentItem[];
}

// ---------- 读：GET /v1/workspace/org/backends ----------

export interface OrgBackendItem {
  sync_id: string;
  name?: string;
  backend_type?: string;
  device_id?: number;
  device_name?: string;
  is_local_reference: boolean;
  availability: OrgExecTargetAvailability;
}

export interface OrgBackendsResponse {
  backends: OrgBackendItem[];
}

// ---------- 写：九个 POST 共用的回执 ----------

export interface OrgWriteResponse {
  sync_id: string;
  version: number;
}

// ---------- 写：字段集合（与 DepartmentFields / AgentFields / ExecTargetFields 对应）----------
//
// 每个键都可选：不传 = 「这次请求没提到这个键」，服务端只覆盖明确涉及的键。
// 空串是一个显式的值（例如 parent_sync_id: "" = 挂到根上），与「不传」不同。

export interface DepartmentFields {
  name?: string;
  description?: string;
  icon?: string;
  accent_color?: string;
  parent_sync_id?: string;
  lead_agent_sync_id?: string;
  // 排序不在其中：规格只把「排序」给了执行目标，部门与 Agent 的次序这一轮浏览器
  // 不动，服务端的 DepartmentFields / AgentFields 也没有这个键——镜像里留着它就是
  // 在宣称一个写不进去的能力。
}

export interface AgentFields {
  name?: string;
  description?: string;
  avatar_color?: string;
  avatar_icon?: string;
  department_sync_id?: string;
  parent_agent_sync_id?: string;
  prompt_json?: string;
  tools_json?: string;
}

export interface ExecTargetFields {
  agent_sync_id?: string;
  backend_sync_id?: string;
  sort_order?: number;
  skills_json?: string;
}
