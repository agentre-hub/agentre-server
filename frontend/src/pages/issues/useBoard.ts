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

import { useAliveEffect } from "@/hooks/use-alive-effect";
import i18n from "@/i18n";
import { ApiTimeoutError } from "@/lib/api";
import { localizeTransportFailure } from "@/lib/writeFailure";
import {
  findSubmittedIssue,
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
  type IssueFields,
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
  /** 搜索框右侧那个命中数。 */
  matchedCount: number;
  /** 这一条任务摊回表单要编辑的那些字段；不在当前结果里就是 `null`。 */
  taskOf: (id: number) => TaskFormValue | null;
  /** 取数在途；旧结果留在原地，只有输入框右端那枚转圈在动。 */
  searching: boolean;
  /**
   * 看板读失败时的**原始**错误（含类名与码），由页面交给 `describeFailure` 分类后
   * 再说给人听；这里不拼文案，也不把 `err.message` 当成可展示的东西。
   */
  error: { cause: unknown } | null;
  /** 重新读一次看板（出错提示上的「重试」）；在途期间 `searching` 为真。 */
  retry: () => void;
  /** 落库走 lib/issues 的 moveIssue：wire 那层是 issue,这一层对外一律 task。 */
  moveTask: (id: number, stage: BoardStage, afterId: number) => Promise<void>;
  saveTask: (value: TaskFormValue) => Promise<void>;
  /**
   * 新建超时之后：重读看板，认出上一次提交的那条（规则见 `findSubmittedIssue`）。
   * 认出返回它摊回表单的值，认不出返回 `null`；重读本身失败则抛出，由调用方说出口。
   */
  findSubmitted: () => Promise<TaskFormValue | null>;
  deleteTask: (id: number) => Promise<void>;
  mutateLabel: (mutation: LabelMutation) => Promise<void>;
}

export function useBoard(
  query: BoardQuery,
  ids: SyncIdRegistry,
  projectOf: BoardCardProjectResolver,
): UseBoardResult {
  const [response, setResponse] = React.useState(EMPTY_RESPONSE);
  const [error, setError] = React.useState<{ cause: unknown } | null>(null);

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
  // 板上已有的任务标识，随每次成功的读更新；新建提交时抓一份当「提交前」的基线。
  const knownIdsRef = React.useRef<ReadonlySet<string>>(new Set());
  const lastCreateRef = React.useRef<{
    fields: IssueFields;
    /** 提交前**不带筛选**的全量标识（读不到则退回当前板上那份）。 */
    knownBefore: Promise<ReadonlySet<string>>;
  } | null>(null);
  /** 新建标签超时且重读失败：那次提交的名字与基线，再提交前据此先核实。 */
  const unverifiedLabelRef = React.useRef<{
    name: string;
    known: ReadonlySet<string>;
  } | null>(null);

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
        // 迟到的结果不写状态，但取回来的数据本身是真的，交给调用方用。
        if (request === requestRef.current) {
          setResponse(board ?? EMPTY_RESPONSE);
          setError(null);
          setLoadedKey(key);
          knownIdsRef.current = new Set(
            (board?.issues ?? []).map((row) => row.sync_id),
          );
        }
        return { board: board ?? EMPTY_RESPONSE, cause: null };
      })
      .catch((cause: unknown) => {
        if (request === requestRef.current) {
          setError({ cause });
          // 失败也要放行那枚转圈，否则它会一直转到下一次输入为止。
          setLoadedKey(key);
        }
        return { board: null, cause };
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

  const moveTask = React.useCallback(
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
        // 基线不能用当前板：板上有筛选时，被筛掉的同名旧任务会被误认成刚建的。
        const onBoard = knownIdsRef.current;
        lastCreateRef.current = {
          fields,
          knownBefore: fetchBoard("")
            .then(
              (all) => new Set((all?.issues ?? []).map((row) => row.sync_id)),
            )
            .catch(() => onBoard),
        };
        await createIssue(fields);
      }
      await reload();
    },
    [ids, reload],
  );

  const findSubmitted = React.useCallback(async () => {
    const last = lastCreateRef.current;
    setRefreshing(true);
    try {
      // 查找不吃板子当前的筛选：新建的那条可能正被关键词 / 范围筛在视野外。全量那份
      // 只用来判定，不写状态；板子自己照旧重读（仍按当前筛选显示）。
      const [, all] = await Promise.all([
        runFetch(),
        fetchBoard("").then(
          (board) => ({ board, cause: null }),
          (cause: unknown) => ({ board: null, cause }),
        ),
      ]);
      if (!all.board) throw all.cause;
      if (!last) return null;
      const found = findSubmittedIssue(
        all.board.issues ?? [],
        last.fields,
        await last.knownBefore,
      );
      return found ? toTaskFormValue(found, ids) : null;
    } finally {
      setRefreshing(false);
    }
  }, [ids, runFetch]);

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
        case "create": {
          // 认「新的 + 同名」：提交前没见过、名字（去空白）一致。
          const createdIn = (
            all: IssueBoardResponse | null,
            known: ReadonlySet<string>,
          ) =>
            (all?.labels ?? []).some(
              (l) =>
                !known.has(l.sync_id) && l.name.trim() === mutation.name.trim(),
            );
          // 上一次超时连重读都失败了：那次可能已经建好。先拿它的基线核实——认出就当作
          // 建成，读仍失败就不发第二个 POST，确定没有才照常提交（规格 F5）。
          const pending = unverifiedLabelRef.current;
          if (pending && pending.name.trim() === mutation.name.trim()) {
            let all: IssueBoardResponse | null;
            try {
              all = await fetchBoard("");
            } catch (cause) {
              throw new Error(i18n.t("issues.labelTimeoutUnchecked"), {
                cause,
              });
            }
            unverifiedLabelRef.current = null;
            if (createdIn(all, pending.known)) break;
          }
          // 提交前的基线取内存里这份名单（不另发读，POST 不等任何东西）；板子还没读回来
          // 时没有基线，超时后不敢认。
          const knownBefore =
            loadedKey === null
              ? null
              : new Set((response.labels ?? []).map((l) => l.sync_id));
          try {
            await createIssueLabel({
              name: mutation.name,
              tone: mutation.tone,
            });
          } catch (err) {
            if (!(err instanceof ApiTimeoutError))
              throw localizeTransportFailure(err);
            // 超时：请求可能已经写进去了。重读全量名单（不带板子当前的筛选）认「新的 +
            // 同名」，认出就当作建成，认不出才让用户再提交。文案不露英文原文。
            let all: IssueBoardResponse | null;
            try {
              all = await fetchBoard("");
            } catch (cause) {
              if (knownBefore !== null)
                unverifiedLabelRef.current = {
                  name: mutation.name,
                  known: knownBefore,
                };
              throw new Error(i18n.t("issues.labelTimeoutUnchecked"), {
                cause,
              });
            }
            if (knownBefore === null) {
              throw new Error(i18n.t("issues.labelTimeoutUnchecked"), {
                cause: err,
              });
            }
            const found = createdIn(all, knownBefore);
            if (!found) {
              throw new Error(i18n.t("issues.labelTimeoutNotFound"), {
                cause: err,
              });
            }
          }
          break;
        }
        // 传输层失败的原文是英文诊断：换成当前语言的一句话（F5、G2）。
        case "update":
          await updateIssueLabel(ids.syncIdOf(mutation.id), {
            name: mutation.name,
            tone: mutation.tone,
          }).catch((err: unknown) => {
            throw localizeTransportFailure(err);
          });
          break;
        case "delete":
          await deleteIssueLabel(ids.syncIdOf(mutation.id)).catch(
            (err: unknown) => {
              throw localizeTransportFailure(err);
            },
          );
          break;
      }
      await reload();
    },
    [ids, reload, loadedKey, response.labels],
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
    retry: () => void reload(),
    moveTask,
    saveTask,
    findSubmitted,
    deleteTask,
    mutateLabel,
  };
}
