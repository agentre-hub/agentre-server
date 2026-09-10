import type { NewConvAgent, NewConvProject } from "./types";

/**
 * 「这个项目里有哪些 Agent」：直接成员 + 继承自父项目的成员。
 *
 * 继承在浏览器这一侧算，不在服务端。服务端只如实回「这个 Agent 直接加入了哪些
 * 项目」（AgentView.ProjectSyncIDs），项目树整份也已经下发（带 parent_sync_id）。
 * 把同一条规则在两边各实现一遍，分叉之后就没人说得清哪个对。
 *
 * 两组互斥：既是直接成员又是祖先成员时只算直接——同一个 Agent 在同一屏里出现
 * 两次，读者会以为是两个。
 */
export function membersOfProject(
  projectSyncId: string,
  projects: NewConvProject[],
  agents: NewConvAgent[],
): { direct: NewConvAgent[]; inherited: NewConvAgent[] } {
  const byId = new Map(projects.map((p) => [p.sync_id, p]));
  if (!byId.has(projectSyncId)) return { direct: [], inherited: [] };

  // 祖先链，从近到远。seen 兜住成环：树是桌面端建的，环不该出现，但真出现时
  // 要的是「列不全」而不是把浏览器挂死在一个 while 里。
  const ancestors: string[] = [];
  const seen = new Set<string>([projectSyncId]);
  let cursor = byId.get(projectSyncId)?.parent_sync_id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.push(cursor);
    cursor = byId.get(cursor)?.parent_sync_id;
  }

  const memberOf = (agent: NewConvAgent, id: string) =>
    (agent.project_sync_ids ?? []).includes(id);

  const direct = agents.filter((a) => memberOf(a, projectSyncId));
  const directIds = new Set(direct.map((a) => a.sync_id));
  // 按祖先由近到远收集：近的先出现，读起来才是「从这一级继承下来的」。
  const inherited: NewConvAgent[] = [];
  const takenIds = new Set(directIds);
  for (const ancestor of ancestors) {
    for (const a of agents) {
      if (takenIds.has(a.sync_id) || !memberOf(a, ancestor)) continue;
      takenIds.add(a.sync_id);
      inherited.push(a);
    }
  }
  return { direct, inherited };
}
