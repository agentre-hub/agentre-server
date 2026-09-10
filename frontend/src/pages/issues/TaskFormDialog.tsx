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
  onClose: () => void;
  onSave: (value: TaskFormValue) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

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
  if (!value) return null;
  return (
    <TaskForm key={value.id ?? 0} value={value} onClose={onClose} {...rest} />
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
  onClose,
  onSave,
  onDelete,
}: TaskFormDialogProps & { value: TaskFormValue }) {
  const [exec, setExec] = React.useState<ExecSelection>(() => ({
    agentBackendSyncId: ids.syncIdOf(value.agentBackendId ?? 0),
    llmProviderKey: value.llmProviderKey,
    llmModelKey: value.llmModelKey,
  }));

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

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-[640px] p-0" showCloseButton={false}>
        <TaskFormShell
          initial={value}
          projects={projects}
          labels={labels}
          agentOptions={agentOptions}
          execTargetPort={execTargetPort}
          modelTargetPort={modelTargetPort}
          onClose={onClose}
          onDelete={
            value.id ? () => void onDelete(value.id as number) : undefined
          }
          // 没有 Agent 时机器与模型两颗 pill 是禁用态、端口根本没被调用，此刻的
          // exec 只可能是换 Agent 之前留下的：跟着存下去等于记了一件从没成立过
          // 的事（读回来时那张卡说「没人负责，但它跑在那台机器上」）。
          onSave={(next) =>
            onSave(
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
          className="max-h-[75vh]"
        />
      </DialogContent>
    </Dialog>
  );
}
