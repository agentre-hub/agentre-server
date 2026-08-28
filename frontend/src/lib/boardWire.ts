/**
 * 看板宿主那一半的**纯翻译层**（规格 2026-08-27「`agentre-server` 端」）。
 *
 * 共享包描述「要什么」（`BoardQuery`）与「画什么」（`BoardViewModel`），线上说的是
 * `/v1/workspace/issues` 那一族的载荷。两者之间隔着两道换算：六个筛选条件翻成 query
 * string，以及**同步标识 ↔ 数字 id**——包里的呈现件按数字认卡片、标签与项目（那是
 * 桌面端本地表的自增主键），账号这一侧根本没有那个数，所以这里发一份只在本页有效的
 * 代号，写回去时再换回同步标识。
 *
 * 没有一行 React、没有一次 fetch：时间预设算成哪一刻、哪一列有几张卡这类判断，摆在
 * 组件里就只能靠渲染整块看板来测。
 */
import {
  BOARD_STAGES,
  activeConditions,
  buildScopeRows,
  type BoardCardProject,
  type BoardCardView,
  type BoardColumnView,
  type BoardQuery,
  type BoardStage,
  type IssueTone,
  type ProjectScope,
  type TaskFormValue,
  type TimeRange,
} from "@agentre-hub/agentre-ui";

import type {
  IssueBoardResponse,
  IssueFields,
  IssueItem,
  ProjectIssueCount,
} from "@/lib/issues";

const DAY_MS = 86_400_000;

/** 「已完成保留多久」换成天数；0 = 不设窗口，那时这个参数整条不发。 */
const DONE_RETENTION_DAYS: Record<string, number> = {
  "30d": 30,
  "90d": 90,
  all: 0,
};

/**
 * 同步标识与数字 id 的双向对照。
 *
 * 代号**只在本页这一次生命周期里有效**，不写进任何请求，也不进地址——它存在的唯一
 * 理由是共享呈现件的 props 说的是数字。0 是保留值：它就是「没有这个东西」（未归属、
 * 没选 Agent），因此空标识与 0 互为对方，不占一个新代号。
 */
export interface SyncIdRegistry {
  idOf: (syncId: string) => number;
  syncIdOf: (id: number) => string;
}

export function createSyncIdRegistry(): SyncIdRegistry {
  const ids = new Map<string, number>();
  const syncIds = new Map<number, string>();
  let next = 0;

  return {
    idOf(syncId) {
      if (!syncId) return 0;
      const known = ids.get(syncId);
      if (known !== undefined) return known;
      next += 1;
      ids.set(syncId, next);
      syncIds.set(next, syncId);
      return next;
    },
    syncIdOf(id) {
      return syncIds.get(id) ?? "";
    },
  };
}

/**
 * 一段时间条件的起止毫秒。0 = 那一端不限——服务端按 `> 0` 才收窄，所以「不限」与
 * 「1970-01-01」在线上是同一件事，这里不必再造一个哨兵。
 */
export function timeRangeToEpoch(
  range: TimeRange,
  nowMs: number,
): { from: number; to: number } {
  switch (range.preset) {
    case "today": {
      const midnight = new Date(nowMs);
      midnight.setHours(0, 0, 0, 0);
      return { from: midnight.getTime(), to: 0 };
    }
    case "7d":
      return { from: nowMs - 7 * DAY_MS, to: 0 };
    case "30d":
      return { from: nowMs - 30 * DAY_MS, to: 0 };
    case "custom":
      return { from: range.from ?? 0, to: range.to ?? 0 };
    default:
      return { from: 0, to: 0 };
  }
}

/** 六个筛选条件 → 一次 `GET /v1/workspace/issues` 的 query string。 */
export function toBoardQueryString(
  query: BoardQuery,
  nowMs: number,
  ids: SyncIdRegistry,
): string {
  const params = new URLSearchParams();
  const put = (key: string, value: number) => {
    if (value > 0) params.set(key, String(value));
  };

  if (query.scope.kind !== "all") params.set("scope", query.scope.kind);
  if (query.scope.kind === "project") {
    params.set("project_sync_id", ids.syncIdOf(query.scope.projectId));
  }
  const keyword = query.keyword.trim();
  if (keyword) params.set("keyword", keyword);
  for (const labelId of query.labelIds) {
    params.append("label_sync_ids", ids.syncIdOf(labelId));
  }
  if (query.labelMatch === "all") params.set("label_match_all", "true");
  if (query.noLabelOnly) params.set("no_label", "true");

  const updated = timeRangeToEpoch(query.updated, nowMs);
  const created = timeRangeToEpoch(query.created, nowMs);
  put("updated_from", updated.from);
  put("updated_to", updated.to);
  put("created_from", created.from);
  put("created_to", created.to);
  put("done_within_days", DONE_RETENTION_DAYS[query.doneRetention] ?? 30);

  // 没有排序参数：看板的顺序是人拖出来的 position（决策 10），线上再没有第二种
  // 次序可选，也就没有一个「按什么排」要说。
  return params.toString();
}

/**
 * 列头是否要变成「命中 / 全部」。
 *
 * **项目范围不算**：`stage_totals` 本来就只吃项目范围，所以只切了范围时分子分母恒等，
 * 画出来是一句「3 / 3」的废话。
 */
export function isFiltering(query: BoardQuery): boolean {
  return activeConditions(query).some((key) => key !== "scope");
}

/** 一条任务要画成卡片时，它的项目那一格由宿主解（范围判据与调色板在宿主手里）。 */
export type BoardCardProjectResolver = (
  projectSyncId: string,
) => BoardCardProject | null;

function toBoardCard(
  issue: IssueItem,
  ids: SyncIdRegistry,
  projectOf: BoardCardProjectResolver,
): BoardCardView {
  return {
    id: ids.idOf(issue.sync_id),
    stage: (issue.stage || "todo") as BoardStage,
    title: issue.title,
    labels: (issue.labels ?? []).map((label) => ({
      id: ids.idOf(label.sync_id),
      name: label.name,
      tone: label.tone as IssueTone,
    })),
    hasDescription: Boolean(issue.description),
    // 正文只在关键词命中它时露一行摘录（呈现件自己判），卡片上从不铺开。
    description: issue.description,
    updatedAt: issue.updated_at,
    project: issue.project_sync_id ? projectOf(issue.project_sync_id) : null,
  };
}

/**
 * 一次响应摊成四列。缺的列给空列而不是不给——四列固定这件事在呈现件那边也兜着，
 * 但让宿主先说全，`total` 才有地方落。
 */
export function toBoardColumns(
  response: IssueBoardResponse,
  ids: SyncIdRegistry,
  projectOf: BoardCardProjectResolver,
): Partial<Record<BoardStage, BoardColumnView>> {
  const byStage = new Map<BoardStage, BoardCardView[]>();
  for (const stage of BOARD_STAGES) byStage.set(stage, []);

  const issues = [...(response.issues ?? [])].sort(
    (a, b) => a.position - b.position,
  );
  for (const issue of issues) {
    const card = toBoardCard(issue, ids, projectOf);
    (byStage.get(card.stage) ?? byStage.get("todo"))?.push(card);
  }

  const columns: Partial<Record<BoardStage, BoardColumnView>> = {};
  for (const stage of BOARD_STAGES) {
    const cards = byStage.get(stage) ?? [];
    columns[stage] = {
      cards,
      total: response.stage_totals?.[stage] ?? cards.length,
      matched: response.stage_counts?.[stage] ?? cards.length,
    };
  }
  return columns;
}

/** 搜索框右侧那个命中数：四列命中之和。 */
export function matchedTotal(stageCounts: Record<string, number>): number {
  return Object.values(stageCounts ?? {}).reduce(
    (sum, count) => sum + (count ?? 0),
    0,
  );
}

/** 项目选择器每一项右侧的子树未完成数；空标识是「未归属」那一档。 */
export function projectCountOf(
  counts: ProjectIssueCount[] | undefined,
  projectSyncId: string,
): number {
  return (
    (counts ?? []).find((row) => row.project_sync_id === projectSyncId)
      ?.count ?? 0
  );
}

/** 一条任务摊回表单要编辑的那些字段（含三个执行字段）。 */
export function toTaskFormValue(
  issue: IssueItem,
  ids: SyncIdRegistry,
): TaskFormValue {
  return {
    id: ids.idOf(issue.sync_id),
    title: issue.title,
    description: issue.description ?? "",
    stage: (issue.stage || "todo") as BoardStage,
    // 线上「未归属」是空标识，表单说的是 null，两者别混着传。
    projectId: ids.idOf(issue.project_sync_id ?? "") || null,
    labelIds: (issue.labels ?? []).map((label) => ids.idOf(label.sync_id)),
    assigneeAgentId: ids.idOf(issue.agent_sync_id ?? "") || null,
    agentBackendId: ids.idOf(issue.agent_backend_sync_id ?? "") || null,
    llmProviderKey: issue.llm_provider_key ?? "",
    llmModelKey: issue.llm_model_key ?? "",
    updatedAt: issue.updated_at,
  };
}

/**
 * 表单的值写回线上。
 *
 * **每个键都显式给出**：表单持有的是这条任务的完整状态，省略某个键的意思是「这次
 * 请求没提到它」，那正是「清掉项目归属」「摘掉全部标签」表达不出来的那件事。
 */
export function toIssueFields(
  value: TaskFormValue,
  ids: SyncIdRegistry,
): IssueFields {
  return {
    title: value.title.trim(),
    description: value.description,
    stage: value.stage,
    project_sync_id: ids.syncIdOf(value.projectId ?? 0),
    agent_sync_id: ids.syncIdOf(value.assigneeAgentId ?? 0),
    agent_backend_sync_id: ids.syncIdOf(value.agentBackendId ?? 0),
    llm_provider_key: value.llmProviderKey,
    llm_model_key: value.llmModelKey,
    label_sync_ids: value.labelIds.map((id) => ids.syncIdOf(id)),
  };
}

/**
 * 卡片上画不画项目字形：判据是**当前范围里是否不止一个项目**。
 *
 * 范围是单个没有子项目的项目时，每张卡都画同一枚字形等于一句重复的废话；「未归属」
 * 里根本没有项目。父子关系从 `depth` 栈推（与 `buildScopeRows` 同一份）。
 */
export function scopeShowsGlyphs(
  scope: ProjectScope,
  projects: { id: number; depth?: number }[],
): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "unassigned") return false;
  const rows = buildScopeRows(
    projects.map((project) => ({
      id: project.id,
      depth: project.depth ?? 0,
      name: "",
    })),
  );
  const row = rows.find((entry) => entry.node.id === scope.projectId);
  return (row?.descendantCount ?? 0) > 0;
}
