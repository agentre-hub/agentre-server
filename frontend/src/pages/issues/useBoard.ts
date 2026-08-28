/**
 * 看板在本站**唯一**的取数口（规格 2026-08-27「`agentre-server` 端」）。
 *
 * 六个筛选条件翻成一次 `GET /v1/workspace/issues`，回来的响应摊成共享呈现件吃的视图
 * 模型；建 / 改 / 移 / 删与标签增删改从这里出去，各自写完就地重拉。与桌面端那份
 * `use-board.ts` 的差别只有一条：那边是 Wails 绑定 + 本地自增主键，这边是 REST +
 * 同步标识，因此多带一本 `SyncIdRegistry`。
 */
import * as React from "react";

import type {
  BoardQuery,
  BoardStage,
  BoardViewModel,
  LabelMutation,
  LabelUsageView,
  TaskFormValue,
} from "@agentre-hub/agentre-ui";

import { useAliveEffect } from "@/hooks/use-api-query";
import {
  isFiltering,
  matchedTotal,
  projectCountOf,
  toBoardColumns,
  toBoardQueryString,
  toIssueFields,
  toTaskFormValue,
  type BoardCardProjectResolver,
  type SyncIdRegistry,
} from "@/lib/boardWire";
import {
  createIssue,
  createIssueLabel,
  deleteIssue,
  deleteIssueLabel,
  fetchBoard,
  moveIssue as moveIssueRequest,
  updateIssue,
  updateIssueLabel,
  type IssueBoardResponse,
} from "@/lib/issues";

const EMPTY_RESPONSE: IssueBoardResponse = {
  issues: [],
  labels: [],
  stage_counts: {},
  stage_totals: {},
  project_counts: [],
};

export interface UseBoardResult {
  viewModel: BoardViewModel;
  labels: LabelUsageView[];
  /** 项目选择器每一项右侧的子树未完成数（不随筛选变）。 */
  projectCountOf: (projectSyncId: string) => number;
  /** 「未归属」那一项的计数；0 = 该入口不出现。 */
  unassignedCount: number;
  /** 当前范围覆盖到的项目；「范围里是否不止一个项目」的判据。 */
  /** 搜索框右侧那个命中数。 */
  matchedCount: number;
  /** 这一条任务摊回表单要编辑的那些字段；不在当前结果里就是 `null`。 */
  taskOf: (id: number) => TaskFormValue | null;
  /** 取数在途；旧结果留在原地，只有输入框右端那枚转圈在动。 */
  searching: boolean;
  error: string | null;
  reload: () => Promise<void>;
  moveIssue: (id: number, stage: BoardStage, afterId: number) => Promise<void>;
  saveTask: (value: TaskFormValue) => Promise<void>;
  deleteTask: (id: number) => Promise<void>;
  mutateLabel: (mutation: LabelMutation) => Promise<void>;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useBoard(
  query: BoardQuery,
  ids: SyncIdRegistry,
  projectOf: BoardCardProjectResolver,
): UseBoardResult {
  const [response, setResponse] = React.useState(EMPTY_RESPONSE);
  const [error, setError] = React.useState<string | null>(null);

  // 只有最新一次请求可以写状态：连打几个字会让多次取数重叠，先发的那次晚返回时
  // 不能把新结果盖回旧的。
  const requestRef = React.useRef(0);
  const queryKey = JSON.stringify(query);
  // 取数要用的是**最新**的 query，但它不能进依赖数组：页面每次渲染新建一个 query
  // 对象就会让取数换身份、effect 再跑一遍，等于每帧重拉。
  const queryRef = React.useRef(query);
  React.useEffect(() => {
    queryRef.current = query;
  });

  // 「手上这份结果是哪一次查询的」。搜索框那枚转圈因此是**推导**出来的，不是一个
  // 要在 effect 里同步拍下去的 state：查询变了而结果还没换，就是在途。
  const [loadedKey, setLoadedKey] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  /**
   * 真正打那一条读端点。写状态一律落在 promise 回调里（与 `useOrgData` 同一种形状）
   * ——effect 体里同步 setState 会引起级联渲染，`react-hooks/set-state-in-effect`
   * 守的就是这条。
   */
  const runFetch = React.useCallback(() => {
    const request = ++requestRef.current;
    const key = JSON.stringify(queryRef.current);
    return fetchBoard(toBoardQueryString(queryRef.current, Date.now(), ids))
      .then((board) => {
        if (request !== requestRef.current) return;
        setResponse(board ?? EMPTY_RESPONSE);
        setError(null);
        setLoadedKey(key);
      })
      .catch((cause: unknown) => {
        if (request !== requestRef.current) return;
        setError(reasonOf(cause));
        // 失败也要放行那枚转圈，否则它会一直转到下一次输入为止。
        setLoadedKey(key);
      });
  }, [ids]);

  useAliveEffect(() => {
    void runFetch();
  }, [queryKey, runFetch]);

  React.useEffect(
    () => () => {
      requestRef.current++;
    },
    [],
  );

  /** 写完就地重拉；只从事件回调里调，不进 effect。 */
  const reload = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await runFetch();
    } finally {
      setRefreshing(false);
    }
  }, [runFetch]);

  const viewModel = React.useMemo<BoardViewModel>(
    () => ({
      columns: toBoardColumns(response, ids, projectOf),
      filtering: isFiltering(query),
      keyword: query.keyword.trim(),
      loading: loadedKey === null,
    }),
    [ids, loadedKey, projectOf, query, response],
  );

  const labels = React.useMemo<LabelUsageView[]>(
    () =>
      (response.labels ?? []).map((label) => ({
        id: ids.idOf(label.sync_id),
        name: label.name,
        tone: label.tone as LabelUsageView["tone"],
        usageCount: label.usage_count,
      })),
    [ids, response.labels],
  );

  const taskOf = React.useCallback(
    (id: number) => {
      const syncId = ids.syncIdOf(id);
      const issue = (response.issues ?? []).find(
        (row) => row.sync_id === syncId,
      );
      return issue ? toTaskFormValue(issue, ids) : null;
    },
    [ids, response.issues],
  );

  const moveIssue = React.useCallback(
    async (id: number, stage: BoardStage, afterId: number) => {
      await moveIssueRequest(ids.syncIdOf(id), stage, ids.syncIdOf(afterId));
      await reload();
    },
    [ids, reload],
  );

  const saveTask = React.useCallback(
    async (value: TaskFormValue) => {
      const fields = toIssueFields(value, ids);
      if (value.id) {
        await updateIssue(ids.syncIdOf(value.id), fields);
      } else {
        await createIssue(fields);
      }
      await reload();
    },
    [ids, reload],
  );

  const deleteTask = React.useCallback(
    async (id: number) => {
      await deleteIssue(ids.syncIdOf(id));
      await reload();
    },
    [ids, reload],
  );

  const mutateLabel = React.useCallback(
    async (mutation: LabelMutation) => {
      switch (mutation.kind) {
        case "create":
          await createIssueLabel({ name: mutation.name, tone: mutation.tone });
          break;
        case "update":
          await updateIssueLabel(ids.syncIdOf(mutation.id), {
            name: mutation.name,
            tone: mutation.tone,
          });
          break;
        case "delete":
          await deleteIssueLabel(ids.syncIdOf(mutation.id));
          break;
      }
      await reload();
    },
    [ids, reload],
  );

  return {
    viewModel,
    labels,
    projectCountOf: React.useCallback(
      (projectSyncId: string) =>
        projectCountOf(response.project_counts, projectSyncId),
      [response.project_counts],
    ),
    unassignedCount: projectCountOf(response.project_counts, ""),
    matchedCount: matchedTotal(response.stage_counts ?? {}),
    taskOf,
    searching: refreshing || loadedKey !== queryKey,
    error,
    reload,
    moveIssue,
    saveTask,
    deleteTask,
    mutateLabel,
  };
}
