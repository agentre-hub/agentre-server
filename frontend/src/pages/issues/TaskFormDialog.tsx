/**
 * 任务表单的宿主外壳。
 *
 * 壳本体是共享包的 `TaskFormShell`；留在这里的是它按定义要不到的两样东西——执行段的
 * 机器与模型两颗 pill（账号侧的后端清单与引擎目录），以及这两颗 pill 选出来的值：
 * 端口只负责画，所以三个执行字段里的后两个由这一层自己持有，提交时并回表单的值。
 *
 * 后端在这一层一律用**同步标识**说话，只在交回共享呈现件与提交时才换成代号
 * （见 `lib/boardWire.ts` 的 `SyncIdRegistry`）。
 */
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import {
  Dialog,
  DialogContent,
  TaskFormShell,
  type BoardAgentOption,
  type ExecPillContext,
  type LabelUsageView,
  type ModelTarget,
  type PickerProvider,
  type ScopeProjectNode,
  type TaskFormValue,
} from "@agentre-hub/agentre-ui";

import { ConfirmSheet } from "@/components/console/ConfirmSheet";
import { backDismissLayerOf, useBackDismiss } from "@/hooks/use-back-dismiss";
import { ApiTimeoutError } from "@/lib/api";
import { localizeTransportFailure } from "@/lib/writeFailure";
import type { SyncIdRegistry } from "@/lib/boardWire";
import type { EngineBackend } from "@/lib/engineCatalog";
import type { OrgBackendItem } from "@/pages/org/types";

import { BoardExecTargetPill } from "./ExecTargetPill";
import { BoardModelPill } from "./ModelPill";

/** 两颗 pill 选出来的值；机器那一颗在这一层说的是同步标识。 */
interface ExecSelection {
  agentBackendSyncId: string;
  llmProviderKey: string;
  llmModelKey: string;
}

export interface TaskFormDialogProps {
  value: TaskFormValue | null;
  projects: ScopeProjectNode[];
  labels: LabelUsageView[];
  agentOptions: BoardAgentOption[];
  /** 账号里**已有**的后端；浏览器建不出后端，这一页也没有那个入口。 */
  backends: OrgBackendItem[];
  /** 上面那份清单是否真的拉回来过（空清单 ≠ 还没拉到）。 */
  backendsLoaded: boolean;
  /** 后端各自绑的供应商 / 模型：「跟随 Agent 绑定」时脸上写的就是它。 */
  engineBackends: EngineBackend[];
  catalog: PickerProvider[];
  ids: SyncIdRegistry;
  /** 手机：任务是整屏页而不是居中弹窗（规格「看板 · 任务详情」）。 */
  page?: boolean;
  onClose: () => void;
  onSave: (value: TaskFormValue) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /**
   * 新建超时后的「刷新看看」：宿主重读看板，认出刚提交的那条就直接打开它并返回
   * `"found"`；认不出返回 `"notFound"`（表单留着、可再提交）；刷新失败由宿主自己说出口
   * 并返回 `"failed"`（还不知道建没建，不算「找不到」）。
   * 只对新建生效——编辑超时不走这条，保持共享壳的原样。
   */
  onRefreshCreated?: () => Promise<RefreshCreatedResult>;
}

/** 「刷新看看」的结论：认出来了 / 确定没有 / 刷新本身失败（仍不知道）。 */
export type RefreshCreatedResult = "found" | "notFound" | "failed";

/**
 * 每次打开都从这条任务已有的值起步：上一条任务选的机器与它无关。这件事由 `key`
 * 说出来（换一条任务 = 换一个实例），而不是靠一支「值变了就把 state 拍回去」的
 * effect —— 那种写法每次都要多渲染一轮，也永远说不清「用户刚改的和外面刚变的谁赢」。
 */
export function TaskFormDialog({
  value,
  onClose,
  ...rest
}: TaskFormDialogProps) {
  const { t } = useTranslation();
  const page = rest.page ?? false;
  const mobilePage = page && value !== null;
  /*
    整屏页进历史、有改动先问（规格 2026-11-25 D2、F4）。这些放在这一层——它一直挂着，
    任务页关掉（保存成功、放弃）时记号才有人退。

    - 系统返回退掉任务页的记号：没改动就关页；有改动则弹「放弃未保存的修改？」，页留着。
      这时记号已经被返回键用掉了，要等确认收起、历史落回原页（layer 为 0）之后再补压
      一条，否则再按一次返回就直接离开看板。补压前 `armed` 为假，不与确认框自己压的
      那条记号抢同一个层数。
    - ✕ 走同一道确认；没改动直接 `onClose`。
  */
  const dirtyRef = React.useRef<() => boolean>(() => false);
  const [confirming, setConfirming] = React.useState(false);
  const [markerLost, setMarkerLost] = React.useState(false);
  const layer = backDismissLayerOf(useLocation().state);
  if (markerLost && !confirming && layer === 0) setMarkerLost(false);
  const armed = !(markerLost && (confirming || layer > 0));
  useBackDismiss(mobilePage && armed, () => {
    if (dirtyRef.current()) {
      setMarkerLost(true);
      setConfirming(true);
    } else {
      onClose();
    }
  });
  const requestClose = React.useCallback(() => {
    if (page && dirtyRef.current()) setConfirming(true);
    else onClose();
  }, [page, onClose]);

  return (
    <>
      {value ? (
        <TaskForm
          key={value.id ?? 0}
          value={value}
          onClose={requestClose}
          dirtyRef={dirtyRef}
          {...rest}
        />
      ) : null}
      <ConfirmSheet
        open={confirming && mobilePage}
        title={t("issues.unsaved.title")}
        description={t("issues.unsaved.body")}
        onCancel={() => setConfirming(false)}
        actions={[
          {
            label: t("issues.unsaved.keep"),
            onSelect: () => setConfirming(false),
            testId: "confirm-keep",
          },
          {
            label: t("issues.unsaved.discard"),
            variant: "secondary",
            onSelect: () => {
              setConfirming(false);
              onClose();
            },
            testId: "confirm-discard",
          },
        ]}
      />
    </>
  );
}

function TaskForm({
  value,
  projects,
  labels,
  agentOptions,
  backends,
  backendsLoaded,
  engineBackends,
  catalog,
  ids,
  page = false,
  onClose,
  onSave,
  onDelete,
  onRefreshCreated,
  dirtyRef,
}: TaskFormDialogProps & {
  value: TaskFormValue;
  /** 外层问「有没有未保存的改动」的口子：整屏页关闭 / 返回前先问（F4）。 */
  dirtyRef: React.MutableRefObject<() => boolean>;
}) {
  const [exec, setExec] = React.useState<ExecSelection>(() => ({
    agentBackendSyncId: ids.syncIdOf(value.agentBackendId ?? 0),
    llmProviderKey: value.llmProviderKey,
    llmModelKey: value.llmModelKey,
  }));

  /*
    有没有未保存的改动（F4）。表单状态在共享包的壳里、没有「脏了」的出口，这里读 DOM：
    标题与描述直接比初值；属性那一排（阶段 / 项目 / 标签 / Agent / 机器 / 模型）靠它们的
    可见文字——用户第一次碰它们之前（pointer / 键盘事件在捕获阶段先于它们的处理）记一
    份基线，之后文字变了才算改过。没碰过就不比，异步到的后端清单改了 pill 文字也不会
    误报。
  */
  const rootRef = React.useRef<HTMLDivElement>(null);
  const pillsBaseline = React.useRef<string | null>(null);
  const readPills = () =>
    rootRef.current?.querySelector('[data-testid="task-form-pills"]')
      ?.textContent ?? "";
  const notePillsTouch = (event: React.SyntheticEvent) => {
    if (pillsBaseline.current !== null) return;
    const target = event.target as Element;
    if (
      target.closest?.(
        '[data-testid="task-title"],[data-testid="task-description"],[data-testid="task-form-close"]',
      )
    )
      return;
    pillsBaseline.current = readPills();
  };
  React.useEffect(() => {
    dirtyRef.current = () => {
      const field = (id: string) =>
        rootRef.current?.querySelector<HTMLInputElement>(
          `[data-testid="${id}"]`,
        )?.value;
      return (
        (field("task-title") ?? value.title) !== value.title ||
        (field("task-description") ?? value.description) !==
          value.description ||
        (pillsBaseline.current !== null &&
          readPills() !== pillsBaseline.current)
      );
    };
    const ref = dirtyRef;
    return () => {
      ref.current = () => false;
    };
  }, [dirtyRef, value.title, value.description]);

  /*
    「刷新看看」在途的那一次。刷新期间用户若又按了提交：不能再发第二个 POST（上一个
    可能已经建好了），先等这次刷新——认出来了宿主已经把表单换成那条任务，这次提交
    就此作罢；认不出才照常提交。

    上一次新建超时、还没核实过（`unverifiedRef`）时，用户不点「刷新看看」直接再按提交
    也一样：先刷新，只有确定没有（notFound）才发 POST（规格 F5「找不到才允许再提交」）。
    刷新本身失败仍是「不知道」：不发 POST，把那次超时原样再抛回去，表单留着那一行。
  */
  const refreshRef = React.useRef<Promise<RefreshCreatedResult> | null>(null);
  const unverifiedRef = React.useRef<unknown>(null);
  const refreshCreated = React.useCallback(() => {
    if (!onRefreshCreated)
      return Promise.resolve<RefreshCreatedResult>("notFound");
    if (!refreshRef.current) {
      const run = onRefreshCreated()
        .then((result) => {
          if (result !== "failed") unverifiedRef.current = null;
          return result;
        })
        .finally(() => {
          refreshRef.current = null;
        });
      refreshRef.current = run;
    }
    return refreshRef.current;
  }, [onRefreshCreated]);
  const saveUnlessFound = async (next: TaskFormValue) => {
    if (!next.id && (refreshRef.current || unverifiedRef.current)) {
      const timeout = unverifiedRef.current;
      const result = await refreshCreated();
      if (result === "found") return;
      if (result === "failed") throw timeout ?? new ApiTimeoutError("", 0);
    }
    try {
      await onSave(next);
    } catch (err) {
      // 新建超时原样抛：共享壳据它画「可能已经建好了 + 刷新看看」。其余传输层失败
      // （编辑超时、非 JSON、断网）的原文是英文诊断，换成当前语言的一句话（F5、G2）。
      if (!next.id && err instanceof ApiTimeoutError) {
        unverifiedRef.current = err;
        throw err;
      }
      throw localizeTransportFailure(err);
    }
  };

  const selectedBackend = backends.find(
    (backend) => backend.sync_id === exec.agentBackendSyncId,
  );
  const boundBackend = engineBackends.find(
    (backend) => backend.sync_id === exec.agentBackendSyncId,
  );

  const execTargetPort = React.useCallback(
    (ctx: ExecPillContext) => (
      <BoardExecTargetPill
        className={ctx.className}
        backends={backends}
        backendsLoaded={backendsLoaded}
        value={exec.agentBackendSyncId}
        onChange={(agentBackendSyncId) =>
          setExec((current) => ({ ...current, agentBackendSyncId }))
        }
        disabled={ctx.disabled}
      />
    ),
    [backends, backendsLoaded, exec.agentBackendSyncId],
  );

  const target = React.useMemo<ModelTarget>(
    () => ({
      providerKey: exec.llmProviderKey,
      modelKey: exec.llmModelKey,
    }),
    [exec.llmModelKey, exec.llmProviderKey],
  );

  const modelTargetPort = React.useCallback(
    (ctx: ExecPillContext) => (
      <BoardModelPill
        className={ctx.className}
        backendType={selectedBackend?.backend_type ?? ""}
        boundProviderKey={boundBackend?.provider_key}
        boundModelKey={boundBackend?.model_key}
        catalog={catalog}
        target={target}
        onChange={(next) =>
          setExec((current) => ({
            ...current,
            llmProviderKey: next.providerKey ?? "",
            llmModelKey: next.modelKey ?? "",
          }))
        }
        disabled={ctx.disabled}
      />
    ),
    [boundBackend, catalog, selectedBackend, target],
  );

  const shell = (
    <TaskFormShell
      page={page}
      initial={value}
      projects={projects}
      labels={labels}
      agentOptions={agentOptions}
      execTargetPort={execTargetPort}
      modelTargetPort={modelTargetPort}
      onClose={onClose}
      onDelete={value.id ? () => void onDelete(value.id as number) : undefined}
      // 没有 Agent 时机器与模型两颗 pill 是禁用态、端口根本没被调用，此刻的
      // exec 只可能是换 Agent 之前留下的：跟着存下去等于记了一件从没成立过
      // 的事（读回来时那张卡说「没人负责，但它跑在那台机器上」）。
      onTimeoutRefresh={
        !value.id && onRefreshCreated ? () => void refreshCreated() : undefined
      }
      onSave={(next) =>
        saveUnlessFound(
          next.assigneeAgentId
            ? {
                ...next,
                agentBackendId: ids.idOf(exec.agentBackendSyncId) || null,
                llmProviderKey: exec.llmProviderKey,
                llmModelKey: exec.llmModelKey,
              }
            : {
                ...next,
                agentBackendId: null,
                llmProviderKey: "",
                llmModelKey: "",
              },
        )
      }
      className={page ? undefined : "max-h-[75vh]"}
    />
  );

  // 整屏页：dvh 高的固定层，键盘升起时可视高度收缩，贴底的 pill 行随之停在键盘上方。
  // 关闭 / 返回在有改动时先问（外层 TaskFormDialog 管确认与历史）。
  if (page) {
    return (
      <div
        ref={rootRef}
        data-testid="issues-task-page"
        onPointerDownCapture={notePillsTouch}
        onClickCapture={notePillsTouch}
        onKeyDownCapture={notePillsTouch}
        // 保存是页头右侧的文字键（D4），不是实心按钮：壳里那颗提交键在这里只改观感。
        className="fixed inset-x-0 top-0 z-50 h-dvh bg-sheet pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] [&_[data-testid=task-form-submit]]:bg-transparent [&_[data-testid=task-form-submit]]:px-3 [&_[data-testid=task-form-submit]]:text-primary-text [&_[data-testid=task-form-submit]]:hover:bg-rail-accent"
      >
        {shell}
      </div>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-[640px] p-0" showCloseButton={false}>
        {shell}
      </DialogContent>
    </Dialog>
  );
}
