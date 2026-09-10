/**
 * 控制台的看板（规格 2026-08-27「看板：项目维度、筛选与呈现重构」的「`agentre-server`
 * 端」）：第 3 个导航项，与桌面端**渲染同一族共享呈现件**——板、范围选择器、六条筛选、
 * 卡片菜单、任务表单与标签管理全部来自 `@agentre-hub/agentre-ui`，本站只留取数、
 * 拖拽手势与执行归属那两颗 pill 的宿主实现。
 *
 * 数据通道是任务、标签与两者关联的那八条端点（读一条、写七条），走与组织面 / 项目面
 * 同一条「浏览器直写 sync_objects」的路子；六个筛选条件与项目子树计数都在服务端算，
 * 这一页只负责把它们说出去、把回来的结果摊开。
 *
 * web 与桌面端**唯一**的功能差别在机器那颗 pill：只能从账号里已有的后端中挑一个，
 * 浏览器建不出 agent backend（见 `pages/issues/ExecTargetPill.tsx`）。
 */
import * as React from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  BoardFilterBar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EMPTY_BOARD_QUERY,
  IssueBoard,
  LabelManagerPanel,
  ProjectScopePicker,
  initialTaskFormValue,
  type BoardAgentOption,
  type BoardCardProject,
  type BoardQuery,
  type BoardStage,
  type ScopeProjectNode,
  type TaskFormValue,
} from "@agentre-hub/agentre-ui";

import AppShell from "@/components/AppShell";
import { orderProjectTree } from "@/components/session/newconv/ProjectAgentPane";
import type { NewConvAgent } from "@/components/session/newconv/types";
import { useAliveEffect } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { createSyncIdRegistry, scopeShowsGlyphs } from "@/lib/boardWire";
import { useEngineCatalog } from "@/lib/engineCatalog";
import { fetchProjects, type ProjectNode } from "@/lib/projects";
import type { OrgBackendItem } from "@/pages/org/types";

import { TaskFormDialog } from "./issues/TaskFormDialog";
import { useBoard } from "./issues/useBoard";
import { useBoardDrag } from "./issues/useBoardDrag";

const STAGES: BoardStage[] = ["todo", "doing", "review", "done"];

export default function Issues() {
  const { t } = useTranslation();
  // 代号本只在本页这一次生命周期里有效，所以它必须比任何一次取数活得久：懒初始化
  // 一次，之后每张卡、每个标签、每个项目都从同一本册子里认号。
  const [ids] = React.useState(createSyncIdRegistry);
  const [query, setQuery] = React.useState<BoardQuery>(EMPTY_BOARD_QUERY);
  const [editing, setEditing] = React.useState<TaskFormValue | null>(null);
  const [labelsOpen, setLabelsOpen] = React.useState(false);

  const [projects, setProjects] = React.useState<ProjectNode[]>([]);
  const [agents, setAgents] = React.useState<NewConvAgent[]>([]);
  const [backends, setBackends] = React.useState<OrgBackendItem[]>([]);
  // 「拉过了」与「拉回来是空的」要分得开：没拉到之前不能判定某个钉住的后端已经
  // 不在账号里（见 ExecTargetPill 里那支重置 effect）。
  const [backendsLoaded, setBackendsLoaded] = React.useState(false);
  const { catalog, backends: engineBackends } = useEngineCatalog();

  // 三份账号级材料只在进页时取一次：它们不随筛选变，跟着每次搜索重拉一遍是白花的
  // 三次往返。取不到就空着——板本身照画，缺的是选择器里的候选。
  useAliveEffect((alive) => {
    Promise.all([
      fetchProjects(),
      api<{ agents?: NewConvAgent[] }>("/v1/workspace/agents"),
      api<{ backends?: OrgBackendItem[] }>("/v1/workspace/org/backends"),
    ])
      .then(([projectList, agentResult, backendResult]) => {
        if (!alive()) return;
        setProjects(projectList);
        setAgents(agentResult.agents ?? []);
        setBackends(backendResult.backends ?? []);
        setBackendsLoaded(true);
      })
      .catch(() => {});
  }, []);

  // 项目树压成扁平前序 + depth（与「新对话」那一处同一份实现）：共享包的范围选择器
  // 与 `buildScopeRows` 认的就是这个形状。
  const ordered = React.useMemo(
    () =>
      orderProjectTree(
        projects.map((project) => ({
          sync_id: project.syncId,
          name: project.name,
          color: project.color,
          icon: project.icon,
          parent_sync_id: project.parentSyncId,
          sort_order: project.sortOrder,
        })),
      ),
    [projects],
  );

  // 卡片上画不画项目字形的判据是「当前范围里是否不止一个项目」；范围是某个含子项目
  // 的父项目时，子项目那些任务额外挂一枚「↳」把层级说出来。
  const showGlyphs = scopeShowsGlyphs(
    query.scope,
    ordered.map((row) => ({
      id: ids.idOf(row.project.sync_id),
      depth: row.depth,
    })),
  );

  const projectOf = React.useCallback(
    (projectSyncId: string): BoardCardProject | null => {
      if (!showGlyphs) return null;
      const project = ordered.find(
        (row) => row.project.sync_id === projectSyncId,
      )?.project;
      if (!project) return null;
      return {
        name: project.name,
        color: project.color,
        icon: project.icon,
        nested:
          query.scope.kind === "project" &&
          ids.idOf(projectSyncId) !== query.scope.projectId,
      };
    },
    [ids, ordered, query.scope, showGlyphs],
  );

  const board = useBoard(query, ids, projectOf);

  const scopeProjects = React.useMemo<ScopeProjectNode[]>(
    () =>
      ordered.map((row) => ({
        id: ids.idOf(row.project.sync_id),
        name: row.project.name,
        depth: row.depth,
        color: row.project.color,
        icon: row.project.icon,
        unfinished: board.projectCountOf(row.project.sync_id),
      })),
    [board, ids, ordered],
  );

  const agentOptions = React.useMemo<BoardAgentOption[]>(
    () =>
      agents.map((agent) => ({
        id: ids.idOf(agent.sync_id),
        name: agent.name,
        color: agent.avatar_color,
      })),
    [agents, ids],
  );

  const { bindings } = useBoardDrag(
    React.useCallback(
      (id: number, stage: BoardStage, afterId: number) => {
        void board.moveIssue(id, stage, afterId);
      },
      [board],
    ),
  );

  const openTask = React.useCallback(
    (cardId: number) => {
      const task = board.taskOf(cardId);
      if (task) setEditing(task);
    },
    [board],
  );

  const columns = board.viewModel.columns;
  const totalTasks = STAGES.reduce(
    (sum, stage) => sum + (columns[stage]?.total ?? 0),
    0,
  );

  return (
    <AppShell title={t("issues.title")} flush>
      <div
        data-testid="issues-page"
        className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      >
        {/* 860px 是规格里那个最小宽度：窄到那里时项目选择器整条换到第二行占满
            宽度，三件东西挤一行会先把它压没。 */}
        <header className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-5 py-3 min-[861px]:h-[60px] min-[861px]:flex-nowrap min-[861px]:py-0">
          <p className="truncate text-2xs text-muted-foreground">
            {t("issues.summary.counts", {
              total: totalTasks,
              doing: columns.doing?.total ?? 0,
            })}
          </p>
          <div className="min-w-0 flex-1 max-[860px]:hidden" />
          <ProjectScopePicker
            scope={query.scope}
            projects={scopeProjects}
            unassignedCount={board.unassignedCount}
            onScopeChange={(scope) =>
              setQuery((current) => ({ ...current, scope }))
            }
            className="max-[860px]:order-last max-[860px]:w-full max-[860px]:max-w-none"
          />
          <div className="min-w-0 flex-1 max-[860px]:hidden" />
          <Button
            type="button"
            size="sm"
            className="h-[30px] max-[860px]:ml-auto"
            onClick={() =>
              setEditing(initialTaskFormValue({ scope: query.scope }))
            }
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {t("issues.actions.newTask")}
          </Button>
        </header>

        <div className="flex min-h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-sidebar px-5 py-2">
          <BoardFilterBar
            query={query}
            labels={board.labels}
            projects={scopeProjects}
            matchedCount={
              board.viewModel.filtering ? board.matchedCount : undefined
            }
            searching={board.searching}
            ports={{ onQueryChange: setQuery }}
            onManageLabels={() => setLabelsOpen(true)}
            className="min-w-0 flex-1"
          />
        </div>

        {board.error ? (
          <p
            role="alert"
            className="shrink-0 bg-destructive-soft px-5 py-2 text-2xs text-destructive-text"
          >
            {board.error}
          </p>
        ) : null}

        <IssueBoard
          viewModel={board.viewModel}
          drag={bindings}
          ports={{
            onEdit: openTask,
            onDelete: (cardId) => void board.deleteTask(cardId),
            onMove: (cardId, stage) => void board.moveIssue(cardId, stage, 0),
            onCreateTask: (stage) =>
              setEditing(initialTaskFormValue({ stage, scope: query.scope })),
            onClearFilters: () => setQuery(EMPTY_BOARD_QUERY),
          }}
        />

        <TaskFormDialog
          value={editing}
          projects={scopeProjects}
          labels={board.labels}
          agentOptions={agentOptions}
          backends={backends}
          backendsLoaded={backendsLoaded}
          engineBackends={engineBackends}
          catalog={catalog}
          ids={ids}
          onClose={() => setEditing(null)}
          onSave={async (next) => {
            await board.saveTask(next);
            setEditing(null);
          }}
          onDelete={async (id) => {
            await board.deleteTask(id);
            setEditing(null);
          }}
        />

        <Dialog open={labelsOpen} onOpenChange={setLabelsOpen}>
          <DialogContent className="max-w-[420px]">
            <DialogHeader>
              <DialogTitle>{t("issues.labelsTitle")}</DialogTitle>
            </DialogHeader>
            <LabelManagerPanel
              labels={board.labels}
              onLabelMutate={board.mutateLabel}
              className="max-h-[60vh]"
            />
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}
