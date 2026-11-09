import type {
  ScopeAgentGroup,
  ScopeAgentItem,
  ScopeListProjectNode,
  ScopeMachineItem,
  ScopeValue,
} from "@agentre-hub/agentre-ui";

import { toAgentStatus } from "@/lib/attentionAdapter";
import {
  deviceDisplayName,
  runsSessions,
  type DeviceItem,
} from "@/lib/devices";
import type { ProjectNode } from "@/lib/projects";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import type { PhoneScope } from "@/pages/chat/phoneScope";

/**
 * 范围弹层的三份清单（规格 2026-11-05「首页」·范围弹层）。
 *
 * 控制台不存业务数据、也没有「每个项目 / Agent / 机器有几条」的端点：每项的数来自
 * **已载入的行**（一次时间轴取数的结果），「有事等你」是这些行里有没有等你输入的。
 * 数的口径因此是「已载入的」——与首页胶囊上的数同源，不另开请求。
 *
 * 各 build 函数收 `null` 表示「数不出来」（还没在「全部」范围下载入过）：每项不摆数，
 * 而不是把手上那一范围之外的项都写成 0。
 */
export interface ScopeTally {
  /** 键 = 同步标识 / 设备标识（字符串）。 */
  project: Map<string, ItemTally>;
  agent: Map<string, ItemTally>;
  machine: Map<string, ItemTally>;
}
interface ItemTally {
  count: number;
  needsYou: boolean;
}

function bump(map: Map<string, ItemTally>, key: string, waiting: boolean) {
  if (!key) return;
  const prev = map.get(key) ?? { count: 0, needsYou: false };
  map.set(key, {
    count: prev.count + 1,
    needsYou: prev.needsYou || waiting,
  });
}

export function tallyRows(rows: readonly MirrorIndexRow[]): ScopeTally {
  const tally: ScopeTally = {
    project: new Map(),
    agent: new Map(),
    machine: new Map(),
  };
  for (const row of rows) {
    const waiting = toAgentStatus(row) === "waiting";
    bump(tally.project, row.projectSyncId, waiting);
    bump(tally.agent, row.agentSyncId, waiting);
    if (row.deviceId !== undefined) {
      bump(tally.machine, String(row.deviceId), waiting);
    }
  }
  return tally;
}

/** 项目树：父项的数含子项（选父项看到的就是整棵子树的对话）。 */
export function buildScopeProjects(
  projects: readonly ProjectNode[],
  tally: ScopeTally | null,
): ScopeListProjectNode[] {
  const byParent = new Map<string, ProjectNode[]>();
  const known = new Set(projects.map((p) => p.syncId));
  for (const project of projects) {
    // 父项不在清单里的挂到根上，别让它从树里消失。
    const parent =
      project.parentSyncId && known.has(project.parentSyncId)
        ? project.parentSyncId
        : "";
    byParent.set(parent, [...(byParent.get(parent) ?? []), project]);
  }
  const build = (
    node: ProjectNode,
    seen: ReadonlySet<string>,
  ): ScopeListProjectNode => {
    const own = tally?.project.get(node.syncId);
    const children = seen.has(node.syncId)
      ? []
      : (byParent.get(node.syncId) ?? [])
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((child) => build(child, new Set(seen).add(node.syncId)));
    return {
      id: node.syncId,
      name: node.name,
      color: node.color || undefined,
      icon: node.icon || undefined,
      count: tally
        ? (own?.count ?? 0) +
          children.reduce((sum, child) => sum + (child.count ?? 0), 0)
        : undefined,
      needsYou: !!own?.needsYou || children.some((child) => child.needsYou),
      children: children.length > 0 ? children : undefined,
    };
  };
  return (byParent.get("") ?? [])
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((root) => build(root, new Set()));
}

/** 弹层吃的 Agent 身份：名单端点已经带着部门名与执行目标。 */
export interface ScopeAgentSource {
  sync_id: string;
  name: string;
  avatar_color?: string;
  avatar_icon?: string;
  department_name?: string;
  has_available_target: boolean;
  /** 名单端点可能不带（缺席即没有）。 */
  exec_targets?: { device_name?: string; current?: boolean }[];
}

/** Agent 按部门分组（首次出现的次序）；没有部门的排在最后，组名由宿主给。 */
export function buildScopeAgentGroups(
  agents: readonly ScopeAgentSource[],
  tally: ScopeTally | null,
  noDepartment: string,
): ScopeAgentGroup[] {
  const groups = new Map<string, ScopeAgentItem[]>();
  for (const agent of agents) {
    const dept = agent.department_name?.trim() ?? "";
    const targets = agent.exec_targets ?? [];
    const target = targets.find((t) => t.current) ?? targets[0];
    const own = tally?.agent.get(agent.sync_id);
    groups.set(dept, [
      ...(groups.get(dept) ?? []),
      {
        id: agent.sync_id,
        name: agent.name,
        color: agent.avatar_color,
        icon: agent.avatar_icon,
        online: agent.has_available_target,
        machineName: target?.device_name,
        count: tally ? (own?.count ?? 0) : undefined,
        needsYou: own?.needsYou,
      },
    ]);
  }
  const named = [...groups.entries()].filter(([dept]) => dept !== "");
  const loose = groups.get("");
  return [
    ...named.map(([dept, list]) => ({ id: dept, name: dept, agents: list })),
    ...(loose ? [{ id: "", name: noDepartment, agents: loose }] : []),
  ];
}

export function buildScopeMachines(
  devices: readonly DeviceItem[],
  tally: ScopeTally | null,
): ScopeMachineItem[] {
  return devices.filter(runsSessions).map((device) => {
    const own = tally?.machine.get(String(device.id));
    return {
      id: String(device.id),
      name: deviceDisplayName(device),
      online: device.online,
      count: tally ? (own?.count ?? 0) : undefined,
      needsYou: own?.needsYou,
    };
  });
}

/** 当前范围 → 清单的选中项。 */
export function scopeValueOf(scope: PhoneScope): ScopeValue {
  switch (scope.kind) {
    case "project":
      return { kind: "project", id: scope.projectSyncId };
    case "agent":
      return { kind: "agent", id: scope.agentSyncId };
    case "machine":
      return {
        kind: "machine",
        id: scope.deviceId === null ? "" : String(scope.deviceId),
      };
    case "all":
      return { kind: "all" };
  }
}

/** 清单的选中 → 页面范围。 */
export function phoneScopeOf(value: ScopeValue): PhoneScope {
  switch (value.kind) {
    case "project":
      return { kind: "project", projectSyncId: value.id };
    case "agent":
      return { kind: "agent", agentSyncId: value.id };
    case "machine":
      return { kind: "machine", deviceId: Number(value.id) };
    case "all":
      return { kind: "all" };
  }
}
