import { useCallback, useEffect, useMemo, useState } from "react";

import {
  iconNode,
  type ProjectHeaderActionsProps,
} from "@agentre-hub/agentre-ui";

import { membersOfProject } from "@/components/session/newconv/projectMembers";
import type {
  NewConvAgent,
  NewConvProject,
} from "@/components/session/newconv/types";
import { createProjectFsPort } from "@/lib/projectFsPort";
import {
  createProjectCreatePorts,
  createProjectDeletePorts,
  createProjectSettingsPorts,
} from "@/lib/projectPorts";
import {
  descendantCount,
  fetchProjectMachines,
  type ProjectMachine,
  type ProjectNode as ApiProject,
} from "@/lib/projects";
import type { ProjectDialogsProps } from "@/pages/chat/ProjectDialogs";

/**
 * 项目管理要向页面借的东西。项目树与 Agent 名单两族都在用（索引的组头、「新对话」
 * 那一屏也读同一份），因此是**借**不是拿：仍旧只有页面那一处取数与那一处重取。
 */
export interface ProjectManagementInput {
  /** 项目树。写成功后 `reloadProjects` 换的就是这一份。 */
  projects: ApiProject[];
  /** 账号下的 Agent 名单：成员名、候选与组头那颗 ＋ 都要它。 */
  agents: NewConvAgent[];
  /** 同一棵树的线上载荷形状（下划线键）；`membersOfProject` 认的是它。 */
  newConvProjects: NewConvProject[];
  /** 写完之后重取项目树。 */
  reloadProjects: () => void;
  /** 组头那颗 ＋ 挑定一个 Agent 之后去哪——「点了之后去哪」归页面。 */
  onNewChat: (agent: NewConvAgent, projectSyncId: string) => void;
}

/** 「对话」页与项目管理那一族之间的全部契约，只有这三样。 */
export interface ProjectManagement {
  /** 组头上那三样动作的材料与去处；交给 `SessionIndex`。 */
  handlers: (projectSyncId: string) => ProjectHeaderActionsProps | null;
  /** 建**顶层**项目：父项目留空。 */
  openCreate: () => void;
  /** 三个弹窗自己的那一份；整个交给 `<ProjectDialogs>`，页面不拆。 */
  dialogs: ProjectDialogsProps;
}

/**
 * 项目的增删改：弹窗状态、写往哪去的 ports、组头动作，以及它们之间的重取。
 *
 * 与会话索引那一族分开住：索引回答「账号里有哪些对话」，这里回答「项目怎么建、
 * 怎么改、怎么删」，两件事只在项目树与 Agent 名单这两份数据上碰头。
 */
export function useProjectManagement({
  projects,
  agents,
  newConvProjects,
  reloadProjects,
  onNewChat,
}: ProjectManagementInput): ProjectManagement {
  /**
   * 项目管理的四处弹窗状态（规格 2026-08-20）。都住在这一页而不是索引里：写请求、
   * 重取与「点了之后去哪」要知道账号与路由的状态，那些在这一层。
   */
  const [createParent, setCreateParent] = useState<ApiProject | null | false>(
    false,
  );
  /**
   * 设置弹窗**只记项目的同步标识**，不记那一刻的项目快照：写成功后 `reloadProjects`
   * 换的是 `projects` 那一份，攥着旧对象的话，加完成员这一屏一动不动——用户看到的
   * 是「加不上」。弹窗显示的必须是服务端确认过的状态。
   */
  const [settingsFor, setSettingsFor] = useState<{
    syncId: string;
    focus?: "members" | "paths";
  } | null>(null);
  const [deleteFor, setDeleteFor] = useState<ApiProject | null>(null);
  const [deleteMachines, setDeleteMachines] = useState<ProjectMachine[]>([]);

  /**
   * 三个弹窗的 ports（规格 2026-08-22 决策 7）。
   *
   * 弹窗本身住在共享包里，两端同一份；本站与桌面端形状最不同的一处是「写往哪去」，
   * 那件事整个收在 `lib/projectPorts` 里。目录选择器那条中继按机器缓存连接，因此
   * 这一层建一次就够 —— 每次渲染新建一个会让选择器每帧重连。
   */
  const fsPort = useMemo(() => createProjectFsPort(), []);
  useEffect(() => () => fsPort.dispose(), [fsPort]);
  const settingsPorts = useMemo(
    () => createProjectSettingsPorts(fsPort),
    [fsPort],
  );
  const createPorts = useMemo(() => createProjectCreatePorts(), []);
  const deletePorts = useMemo(() => createProjectDeletePorts(), []);

  /** 父项目下拉的候选；包会把「它自己」剔掉。 */
  const parentOptions = useMemo(
    () => projects.map((p) => ({ id: p.syncId, name: p.name })),
    [projects],
  );

  /**
   * 设置弹窗当前对着的那个项目，**每次重取之后现取**——攥着快照就看不见自己的改动。
   *
   * 翻成包认识的 view：成员是这个项目已经有的，候选是账号下其余的 Agent。
   */
  const settingsProject = useMemo(() => {
    const project = settingsFor
      ? (projects.find((p) => p.syncId === settingsFor.syncId) ?? null)
      : null;
    if (!project) return null;
    const nameOf = (syncId: string) =>
      agents.find((a) => a.sync_id === syncId)?.name ?? syncId;
    const memberAgentIds = new Set(project.members.map((m) => m.agentSyncId));
    return {
      id: project.syncId,
      name: project.name,
      description: project.description,
      icon: project.icon,
      color: project.color,
      parentId: project.parentSyncId,
      // 包删成员用的是 view 上的 id，本站删的是那条成员关系记录 —— 所以给 syncId。
      members: project.members.map((m) => {
        const agent = agents.find((a) => a.sync_id === m.agentSyncId);
        return {
          id: m.syncId,
          name: nameOf(m.agentSyncId),
          color: agent?.avatar_color,
          avatarIcon: iconNode(agent?.avatar_icon),
        };
      }),
      candidates: agents
        .filter((a) => !memberAgentIds.has(a.sync_id))
        .map((a) => ({
          id: a.sync_id,
          name: a.name,
          color: a.avatar_color,
          avatarIcon: iconNode(a.avatar_icon),
        })),
    };
  }, [projects, settingsFor, agents]);

  /**
   * 删除确认要点名「此刻离线、要等下次上线才跟着删」的机器。
   *
   * 只算**配了这个项目**的那几台：离线但没配这个项目的机器不跟着删，说出来是句
   * 凭空的坏消息。
   */
  const offlineMachineNames = useMemo(
    () =>
      deleteMachines
        .filter((m) => m.configured && !m.online)
        .map((m) => m.deviceName),
    [deleteMachines],
  );

  /**
   * 组头上那三样动作要用的材料与去处。索引自己既不知道账号里有哪些 Agent，
   * 也不该替这一页决定「点了之后去哪」，因此由这里给。
   */
  const handlers = useCallback(
    (projectSyncId: string): ProjectHeaderActionsProps | null => {
      const project = projects.find((p) => p.syncId === projectSyncId);
      if (!project) return null;
      // ＋ 列的是「在这个项目里能找谁开对话」：直接成员 + 继承自祖先项目的成员，
      // 与「从项目里挑一个 Agent」那一屏同一条规则（membersOfProject），也与桌面端
      // project-group-header.tsx 一致。只列直接成员的话，没加过人的子项目里那个 ＋
      // 永远是一句「还没有成员」——而账号里明明有 Agent 管得着它。
      const { direct, inherited } = membersOfProject(
        projectSyncId,
        newConvProjects,
        agents,
      );
      const member = (a: NewConvAgent, isInherited: boolean) => ({
        id: a.sync_id,
        name: a.name,
        color: a.avatar_color,
        avatarIcon: iconNode(a.avatar_icon),
        inherited: isInherited,
      });
      const members = [
        ...direct.map((a) => member(a, false)),
        ...inherited.map((a) => member(a, true)),
      ];
      return {
        projectId: projectSyncId,
        projectName: project.name,
        // 这一端手里已经有成员了，回一个已决议的 promise —— 包在**打开浮层之前**
        // 调它，恰好一个成员时直接开对话、根本不弹。
        loadMembers: async () => members,
        unconfigured: !project.configured,
        // 这一端既没有终端也没有合并，两条整条不出现（不是置灰）。
        capabilities: { terminal: false, merge: false },
        onNewChat: (pid, agentSyncId) => {
          const agent = agents.find((a) => a.sync_id === agentSyncId);
          if (agent) onNewChat(agent, pid);
        },
        onOpenSettings: (pid, focus) => setSettingsFor({ syncId: pid, focus }),
        onNewSubproject: () => setCreateParent(project),
        onDelete: () => {
          setDeleteFor(project);
          // 删除确认要点名「此刻离线、要等下次上线才跟着删」的机器，那份材料只有
          // 这个端点答得出来；取不到就按「没有离线的」渲染，不阻塞确认。
          setDeleteMachines([]);
          fetchProjectMachines(project.syncId)
            .then(setDeleteMachines)
            .catch(() => {});
        },
      };
    },
    [projects, newConvProjects, agents, onNewChat],
  );

  const openCreate = useCallback(() => setCreateParent(null), []);

  return {
    handlers,
    openCreate,
    dialogs: {
      create: {
        parent: createParent,
        parentOptions,
        ports: createPorts,
        close: () => setCreateParent(false),
        onCreated: () => {
          setCreateParent(false);
          reloadProjects();
        },
      },
      settings: {
        project: settingsProject,
        parentOptions,
        focus: settingsFor?.focus,
        ports: settingsPorts,
        close: () => setSettingsFor(null),
        onChanged: reloadProjects,
      },
      deletion: {
        project: deleteFor && { id: deleteFor.syncId, name: deleteFor.name },
        childCount: deleteFor ? descendantCount(projects, deleteFor.syncId) : 0,
        offlineMachines: offlineMachineNames,
        ports: deletePorts,
        close: () => setDeleteFor(null),
        onDeleted: () => {
          setDeleteFor(null);
          reloadProjects();
        },
      },
    },
  };
}
