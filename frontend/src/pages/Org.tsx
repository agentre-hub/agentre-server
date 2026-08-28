/**
 * server 控制台的组织面（规格 2026-08-18「server 端的组织管理面」）：第 5 个导航项，
 * 与桌面端同形的组织索引 + 详情，外壳仍是这份 224px 带文字 SideNav
 * （`AppShell.tsx` 的 `NAV_ITEMS`）。
 *
 * 写入路径：浏览器 → REST 端点 → server 直写 sync_objects，不需要桌面端在线
 * （`useOrgData` 的 `reload` 是唯一的读入口，每次写完都会重新拉一遍）。
 *
 * **通道整个关掉时这个页面必须照常正确**：`useOrgData` 已经把这条焊死了——
 * 首次加载与每一次写后刷新都走 `reload()`，账号级实时通道只是在它能连上的时候把
 * 「该拉了」提前触发，见 `useOrgData.ts` 顶部注释。
 */
import * as React from "react";
import { Building2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import AppShell from "@/components/AppShell";
import { useIsMobile } from "@/components/use-is-mobile";
import { EmptyState } from "@/components/console";
import { Button, cn, type OrgSelection } from "@agentre-hub/agentre-ui";

import { buildOrgModels } from "./org/adapter";
import {
  CreateAgentDialog,
  CreateDepartmentDialog,
} from "./org/OrgCreateDialogs";
import { OrgAgentDetail } from "./org/OrgAgentDetail";
import { OrgDepartmentDetail } from "./org/OrgDepartmentDetail";
import { OrgIndexPanel } from "./org/OrgIndexPanel";
import { useOrgData } from "./org/useOrgData";
import * as writes from "./org/writes";

type SyncSelection = { kind: "agent" | "department"; syncId: string } | null;

export default function Org() {
  const { t } = useTranslation();
  const { chart, backends, loading, error, reload } = useOrgData();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const params = useParams<{ kind?: string; syncId?: string }>();

  // 选中态的真源是**地址**，不是页面内的一个 state。移动端下钻靠它才让手机的返回键
  // 有用（本仓会话详情走的也是这条：Chat 的行是 /devices/:did/sessions/:sid），
  // 顺带把深链接白拿到手。sync_id 跨刷新稳定，所以放进地址是安全的——数字 id 不行，
  // 那是每份响应快照现分的（见 adapter.ts 顶部）。
  // useMemo 不是为了省这一次三元运算，而是为了让引用稳定：下游几个 useMemo 都把
  // selection 列进依赖，每渲染一个新对象就等于那几段全部白算一遍。
  const { kind: paramKind, syncId: paramSyncId } = params;
  const selection: SyncSelection = React.useMemo(
    () =>
      (paramKind === "agent" || paramKind === "department") && paramSyncId
        ? { kind: paramKind, syncId: paramSyncId }
        : null,
    [paramKind, paramSyncId],
  );
  const setSelection = React.useCallback(
    (next: SyncSelection) => {
      navigate(next ? `/org/${next.kind}/${next.syncId}` : "/org");
    },
    [navigate],
  );
  const [createDeptOpen, setCreateDeptOpen] = React.useState(false);
  const [createAgentOpen, setCreateAgentOpen] = React.useState(false);
  // 两个「建」弹层的上下文：从组头的动作进来时它带着那个部门，从空态或工具条进来
  // 时是空串（顶层 / 由弹层自己挑）。开弹层一律经下面两个函数，不直接拨 open——
  // 直接拨会把上一次留下的上下文带进这一次，于是从空态点「新建部门」建出来的东西
  // 悄悄挂到了上回那个部门下面。
  const [createDeptParentSync, setCreateDeptParentSync] = React.useState("");
  const [createAgentDeptSync, setCreateAgentDeptSync] = React.useState("");
  const openCreateDepartment = React.useCallback((parentSyncId = "") => {
    setCreateDeptParentSync(parentSyncId);
    setCreateDeptOpen(true);
  }, []);
  const openCreateAgent = React.useCallback((departmentSyncId = "") => {
    setCreateAgentDeptSync(departmentSyncId);
    setCreateAgentOpen(true);
  }, []);
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  // 每一次写操作共用同一条失败路径：写失败不吞掉——吞掉的话用户点了删除/保存,
  // 什么都没发生,连个错误都看不到,以为是自己没点中。成功时顺带清掉上一条旧错误。
  const runMutation = React.useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setMutationError(null);
      } catch {
        setMutationError(t("org.errors.generic"));
      }
    },
    [t],
  );

  // 详情表单的字段编辑是 onBlur 静默提交，反馈归详情头部自己（见 OrgDetailHeader）：
  // 那条保存态就在被编辑的字段旁边，而索引列底部那行小字离得太远——改完一个字段的人
  // 不会往那儿看。所以这一条路径只负责把成功时的旧错误清掉，失败原样抛回去。
  const runFieldUpdate = React.useCallback(
    async (fn: () => Promise<unknown>) => {
      await fn();
      setMutationError(null);
    },
    [],
  );

  const models = React.useMemo(
    () => buildOrgModels(chart ?? { departments: [], agents: [] }),
    [chart],
  );

  const numericSelection: OrgSelection = React.useMemo(() => {
    if (!selection) return null;
    const id =
      selection.kind === "agent"
        ? models.maps.agentIdOf(selection.syncId)
        : models.maps.deptIdOf(selection.syncId);
    return id > 0 ? { kind: selection.kind, id } : null;
  }, [selection, models.maps]);

  const handleSelect = (next: OrgSelection) => {
    if (!next) {
      setSelection(null);
      return;
    }
    const syncId =
      next.kind === "agent"
        ? models.maps.agentSyncOf(next.id)
        : models.maps.deptSyncOf(next.id);
    if (!syncId) return;
    setSelection({ kind: next.kind, syncId });
  };

  const selectedAgent =
    selection?.kind === "agent"
      ? models.agentBySync.get(selection.syncId)
      : undefined;
  const selectedAgentModel =
    selectedAgent &&
    models.agents.find(
      (a) => a.id === models.maps.agentIdOf(selectedAgent.sync_id),
    );
  const selectedDepartment =
    selection?.kind === "department"
      ? models.departmentBySync.get(selection.syncId)
      : undefined;
  const selectedDepartmentModel =
    selectedDepartment &&
    models.departments.find(
      (d) => d.id === models.maps.deptIdOf(selectedDepartment.sync_id),
    );

  // 移动端一次只摆一页；桌面端两栏都在。
  const showIndex = !isMobile || !selection;
  const showDetail = !isMobile || Boolean(selection);

  return (
    <AppShell title={t("org.pageTitle")}>
      <div
        data-testid="org-layout"
        className={cn(
          "-mx-4 -my-5 flex h-full md:-mx-8 md:-my-6",
          // 窄屏没有并排的空间（mockup `11-mobile.png`）：320px 索引 + 详情挤在
          // 390px 里，详情只剩几十像素。移动端一次只摆一页：索引升整页，点一行
          // 下钻到详情，返回回索引。
          isMobile ? "flex-col" : "flex-row",
        )}
      >
        {/* 索引列 320px（mockup `.index`），底色与右边框走 sidebar 那一套 token——
            它与 AppShell 的 224px SideNav 是同一族「侧面」，而不是一张 card：行与组头
            的 hover/选中面（包里读的是 --sidebar-active-bg / --sidebar-selected-bg）
            正是照 --sidebar 这个底调出来的，落在 card 上对比度就不对了。
            移动端它是整页，宽度与右边框都交出去。 */}
        {showIndex && (
          <div
            data-testid="org-index-col"
            className={cn(
              "flex min-w-0 flex-col bg-sidebar",
              isMobile
                ? "min-h-0 flex-1"
                : "w-[320px] shrink-0 border-r border-sidebar-border",
            )}
          >
            {loading && !chart ? (
              <p className="p-4 text-sm text-muted-foreground">
                {t("common.loading")}
              </p>
            ) : (
              <OrgIndexPanel
                departments={models.departments}
                agents={models.agents}
                backends={backends}
                agentBySync={models.agentBySync}
                maps={models.maps}
                selection={numericSelection}
                onSelect={handleSelect}
                onCreateDepartment={(parentDepartmentId) =>
                  openCreateDepartment(
                    parentDepartmentId
                      ? models.maps.deptSyncOf(parentDepartmentId)
                      : "",
                  )
                }
                onCreateAgent={(departmentId) =>
                  openCreateAgent(
                    departmentId ? models.maps.deptSyncOf(departmentId) : "",
                  )
                }
              />
            )}
            {(error ?? mutationError) && (
              <p
                role="alert"
                className="border-t border-border p-2.5 text-2xs text-destructive"
              >
                {error ? t("org.errors.generic") : mutationError}
              </p>
            )}
          </div>
        )}

        {showDetail && (
          <div
            data-testid="org-detail-col"
            className="flex min-w-0 flex-1 flex-col"
          >
            {selectedAgent && selectedAgentModel ? (
              <OrgAgentDetail
                // key 强制在切到另一个 Agent 时整个重挂载：详情表单的字段状态
                // （name/description/…）只在挂载时从 props 取初值，同一个组件实例
                // 切换 selection 不会自动重新读一遍——不加这个 key，从 Alice 切到
                // Bob 会看见 Alice 还没保存掉的字段残留在 Bob 的表单里。
                key={selectedAgent.sync_id}
                agent={selectedAgent}
                agentModel={selectedAgentModel}
                agents={models.agents}
                departments={models.departments}
                backends={backends}
                maps={models.maps}
                onUpdate={(fields) =>
                  runFieldUpdate(async () => {
                    await writes.updateAgent(selectedAgent.sync_id, fields);
                    await reload();
                  })
                }
                onDelete={() =>
                  runMutation(async () => {
                    await writes.deleteAgent(selectedAgent.sync_id);
                    setSelection(null);
                    await reload();
                  })
                }
                onCreateExecTarget={(backendSyncId) => {
                  void runMutation(async () => {
                    await writes.createExecTarget({
                      agent_sync_id: selectedAgent.sync_id,
                      backend_sync_id: backendSyncId,
                    });
                    await reload();
                  });
                }}
                onRemoveExecTarget={(syncId) => {
                  void runMutation(async () => {
                    await writes.deleteExecTarget(syncId);
                    await reload();
                  });
                }}
                onChangeExecTargetSkills={(syncId, skillsJson) => {
                  void runMutation(async () => {
                    await writes.updateExecTarget(syncId, {
                      skills_json: skillsJson,
                    });
                    await reload();
                  });
                }}
                onReload={() => void reload()}
                onBack={isMobile ? () => setSelection(null) : undefined}
                onClose={() => setSelection(null)}
              />
            ) : selectedDepartment && selectedDepartmentModel ? (
              <OrgDepartmentDetail
                key={selectedDepartment.sync_id}
                department={selectedDepartment}
                departmentModel={selectedDepartmentModel}
                agents={models.agents}
                departments={models.departments}
                maps={models.maps}
                onUpdate={(fields) =>
                  runFieldUpdate(async () => {
                    await writes.updateDepartment(
                      selectedDepartment.sync_id,
                      fields,
                    );
                    await reload();
                  })
                }
                onDelete={() =>
                  runMutation(async () => {
                    await writes.deleteDepartment(selectedDepartment.sync_id);
                    setSelection(null);
                    await reload();
                  })
                }
                onBack={isMobile ? () => setSelection(null) : undefined}
                onClose={() => setSelection(null)}
              />
            ) : (
              // 没选中任何一行时主区交白卷（mockup `09-empty` ①）：不是一行灰字，而是
              // 带出路的空态——按钮只放这一页真的到得了的两个动作，两个建弹层都在下面。
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <EmptyState
                  icon={Building2}
                  title={t("org.detail.empty.title")}
                  testId="org-detail-empty"
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="sm" onClick={() => openCreateDepartment()}>
                        {t("org.index.newDepartment")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openCreateAgent()}
                      >
                        {t("org.index.newAgent")}
                      </Button>
                    </div>
                  }
                />
              </div>
            )}
          </div>
        )}
      </div>

      <CreateDepartmentDialog
        open={createDeptOpen}
        onOpenChange={setCreateDeptOpen}
        onCreate={(name) => {
          setCreateDeptOpen(false);
          void runMutation(async () => {
            const res = await writes.createDepartment({
              name,
              // 组头的 ⋮ 进来时是子部门；空态进来时不带这个键（不是空串——空串是
              // 「显式挂到根上」这个值，与「这次请求没提到」不同，见 types.ts）。
              ...(createDeptParentSync
                ? { parent_sync_id: createDeptParentSync }
                : {}),
            });
            await reload();
            setSelection({ kind: "department", syncId: res.sync_id });
          });
        }}
      />
      <CreateAgentDialog
        open={createAgentOpen}
        onOpenChange={setCreateAgentOpen}
        departments={chart?.departments ?? []}
        defaultDepartmentSyncId={createAgentDeptSync}
        onCreate={(name, departmentSyncId) => {
          setCreateAgentOpen(false);
          void runMutation(async () => {
            const res = await writes.createAgent({
              name,
              department_sync_id: departmentSyncId || undefined,
            });
            await reload();
            setSelection({ kind: "agent", syncId: res.sync_id });
          });
        }}
      />
    </AppShell>
  );
}
