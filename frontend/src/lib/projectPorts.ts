/**
 * 本站这一侧的项目 ports（规格 2026-08-22 B 段，决策 7）。
 *
 * 三个弹窗（设置 / 新建 / 删除确认）住在 `@agentre-hub/agentre-ui` 里，两端同一份。
 * 这里做的只有一件事：把本站的 REST + 中继翻成包认识的契约。
 *
 * **本站与桌面端形状最不同的一处就在「写往哪去」**：agentred 的路径是账号级同步
 * 对象，走 REST 由服务端直写（离线也配得了）；桌面端的本机路径只住在它自己的上报组、
 * 整份快照替换，服务端写一行下次上报就被冲掉，所以要经中继喊那台机器自己写 —— 代价
 * 是它必须在线。这条判定只由「那台机器是哪一类」决定，与界面无关，因此归这里。
 */
import type {
  ProjectCreatePorts,
  ProjectDeletePorts,
  ProjectFieldValues,
  ProjectMachineView,
  ProjectSettingsPorts,
  ProjectWriteFailure,
  ProjectWriteOutcome,
} from "@agentre-hub/agentre-ui";

import {
  addProjectMember,
  createProject,
  deleteProject,
  deleteProjectLocation,
  fetchProjectMachines,
  removeProjectMember,
  setProjectLocation,
  updateProject,
  type ProjectFields,
  type ProjectMachine,
} from "@/lib/projects";
import {
  classifyProjectLocalPathError,
  clearLocalPathOnMachine,
  setLocalPathOnMachine,
} from "@/lib/projectLocalPath";
import { errorMessage } from "@/lib/projectErrors";
import type { DisposableProjectFsPort } from "@/lib/projectFsPort";

/**
 * REST 那一路的失败：**分类交 `unknown`，把服务端那句业务文案原样带上**。
 *
 * 服务端的业务码自带 i18n 文案（「该 Agent 已经是这个项目的成员」），它比任何前端
 * 编的兜底都具体。包的规则正好是「`unknown` 那一档显示宿主给的 message」，两边对上。
 */
function restFailure(err: unknown): ProjectWriteFailure {
  return { kind: "unknown", message: errorMessage(err, "") };
}

async function rest(run: () => Promise<unknown>): Promise<ProjectWriteOutcome> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    return { ok: false, failure: restFailure(err) };
  }
}

/**
 * 中继那一路的失败：**按错误码分类**，不带那台机器的 Go 文本。
 *
 * 「还没同步到这个项目」与「路径不存在」的出路完全不同（前者等一会儿就好，后者要去
 * 挑别的目录），包为每一类写好了一句；把 Go 原文透出去反而会盖掉那一句。
 */
async function relay(
  run: () => Promise<unknown>,
): Promise<ProjectWriteOutcome> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    // 本站的分类词汇与包的 ProjectWriteFailureKind 同名同义，直接过。
    return { ok: false, failure: classifyProjectLocalPathError(err) };
  }
}

/** 包只递改动的那几格；键名从驼峰翻成 wire 上的形状。 */
function toWireFields(fields: ProjectFieldValues): ProjectFields {
  const out: ProjectFields = {};
  if (fields.name !== undefined) out.name = fields.name;
  if (fields.description !== undefined) out.description = fields.description;
  if (fields.icon !== undefined) out.icon = fields.icon;
  if (fields.color !== undefined) out.color = fields.color;
  if (fields.parentId !== undefined) out.parent_sync_id = fields.parentId;
  return out;
}

function toMachineView(m: ProjectMachine): ProjectMachineView {
  return {
    id: m.fingerprint,
    name: m.deviceName,
    kind: m.kind === "agentred" ? "agentred" : "desktop",
    online: m.online,
    path: m.path,
    // agentred 的路径服务端直写，离线也配得了；桌面端的要经中继喊它自己写。
    writeNeedsOnline: m.kind !== "agentred",
    // 两类机器问的不是同一件事：agentred 问「同步组里有没有那一行」（删的就是它），
    // 桌面端在同步组里没有行，问的是「那台机器上配了没有」。
    removable: m.kind === "agentred" ? !!m.locationSyncId : m.configured,
  };
}

export function createProjectSettingsPorts(
  fs: DisposableProjectFsPort,
): ProjectSettingsPorts {
  /**
   * 上一次读回来的清单，按指纹索引。
   *
   * 只为一件事存在：删 agentred 的路径要那条同步对象的 `locationSyncId`，而那是
   * wire 细节、不该进包的 view。弹窗里能按到「移除」就一定先读过清单，所以这里查得到。
   */
  const lastMachines = new Map<string, ProjectMachine>();

  return {
    updateFields: (projectId, fields) =>
      rest(() => updateProject(projectId, toWireFields(fields))),

    addMember: (projectId, candidateId) =>
      rest(() => addProjectMember(projectId, candidateId)),

    // 本站删的是那条成员关系记录，它的 id 就是 view 上的 id。
    removeMember: (_projectId, member) =>
      rest(() => removeProjectMember(member.id)),

    listMachines: async (projectId) => {
      const rows = await fetchProjectMachines(projectId);
      lastMachines.clear();
      for (const m of rows) lastMachines.set(m.fingerprint, m);
      return rows.map(toMachineView);
    },

    setMachinePath: (projectId, machine, path) =>
      machine.kind === "agentred"
        ? rest(() => setProjectLocation(projectId, machine.id, path))
        : relay(() => setLocalPathOnMachine(machine.id, projectId, path)),

    clearMachinePath: async (projectId, machine) => {
      if (machine.kind !== "agentred") {
        return relay(() => clearLocalPathOnMachine(machine.id, projectId));
      }
      const locationSyncId = lastMachines.get(machine.id)?.locationSyncId;
      // 拿不到那条同步对象的 id 就**当场说不知道**，不拿空串去打端点 —— 那会换回
      // 一个 404，用户读到的是「这次改动没生效」，而真实原因是这一层没接上。
      if (!locationSyncId) {
        return { ok: false, failure: { kind: "unknown", message: "" } };
      }
      return rest(() => deleteProjectLocation(locationSyncId));
    },

    fs,
    // web 宿主没有「本机」，所以不挂原生目录对话框 —— 没有那个 port 就没有那条路。
  };
}

export function createProjectCreatePorts(): ProjectCreatePorts {
  return {
    create: async (draft) => {
      // 指针语义：**只送这次真的填了的键**，没填的不翻成空串送下去。
      const fields: ProjectFields = { name: draft.name };
      if (draft.description) fields.description = draft.description;
      if (draft.icon) fields.icon = draft.icon;
      if (draft.color) fields.color = draft.color;
      if (draft.parentId) fields.parent_sync_id = draft.parentId;
      try {
        const created = await createProject(fields);
        return { ok: true, id: created.sync_id };
      } catch (err) {
        return { ok: false, failure: restFailure(err) };
      }
    },
    // 本机路径与 git 探测都是「摸得到本机文件系统」才有的能力，浏览器上没有。
    // 路径不必填是两端共同的规则（决策 9），不是这一端的特例。
  };
}

export function createProjectDeletePorts(): ProjectDeletePorts {
  return { deleteProject: (projectId) => rest(() => deleteProject(projectId)) };
}
