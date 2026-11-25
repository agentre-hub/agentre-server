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
import { api, ApiTimeoutError } from "@/lib/api";
import { errorText } from "@/lib/errorText";
import { describeFailure } from "@/lib/describeFailure";
import { transportFailureText } from "@/lib/writeFailure";
import { useIsMobile } from "@/components/use-is-mobile";
import { EmptyState, FailureNotice, useMobileBack } from "@/components/console";
import {
  Button,
  Skeleton,
  cn,
  type OrgSelection,
} from "@agentre-hub/agentre-ui";

import { buildOrgModels } from "./org/adapter";
import type {
  AgentFields,
  DepartmentFields,
  OrgChartResponse,
} from "./org/types";
import {
  CreateAgentDialog,
  CreateDepartmentDialog,
} from "./org/OrgCreateDialogs";
import { OrgAgentDetail } from "./org/OrgAgentDetail";
import { OrgDepartmentDetail } from "./org/OrgDepartmentDetail";
import { OrgAddMenu, OrgIndexPanel } from "./org/OrgIndexPanel";
import { useOrgData } from "./org/useOrgData";
import * as writes from "./org/writes";

/**
 * 索引列首屏的骨架：一条工具条 + 交替的组头/缩进行。
 *
 * 形照索引的真实构成来，**不**做成树骨架（三角、连接线）——这一屏本来就是扁平的
 * 组头加缩进行，没有展开动画。骨架自己 aria-hidden，「在取」由容器上的 aria-busy 说。
 */
function OrgIndexSkeleton() {
  return (
    <div data-testid="org-index-loading" aria-busy="true" className="min-w-0">
      <div aria-hidden="true" className="flex flex-col gap-2 p-2.5">
        <Skeleton className="h-8 w-full rounded-md" />
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const isHeader = i % 3 === 0;
          return (
            <Skeleton
              key={i}
              className={isHeader ? "h-3" : "h-6 rounded-md"}
              style={{
                marginLeft: isHeader ? 4 : 18,
                width: isHeader ? "38%" : `${72 - (i % 3) * 10}%`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 详情列首屏的骨架：头部一条标题 + 两节字段。 */
function OrgDetailSkeleton() {
  return (
    <div
      data-testid="org-detail-loading"
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div aria-hidden="true" className="flex flex-col gap-5 p-5">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 shrink-0 rounded-md" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-2.5 w-24" />
          </span>
        </div>
        {[0, 1].map((section) => (
          <div key={section} className="flex flex-col gap-2.5">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-3/4 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

type SyncSelection = { kind: "agent" | "department"; syncId: string } | null;

export default function Org() {
  const { t } = useTranslation();
  const { chart, backends, loading, error, failure, reload } = useOrgData();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  // ‹ = 回到上一处（D3）：有上一处退一步、没有则以替换回 /org；不 push，历史不变长。
  const back = useMobileBack();
  const params = useParams<{ kind?: string; syncId?: string }>();

  // 选中态的真源是**地址**，不是页面内的一个 state。移动端下钻靠它才让手机的返回键
  // 有用（本仓会话详情走的也是这条：Chat 的行是 /chat/:conversationId），
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
  const mutationErrorRevision = React.useRef(0);

  // 每一次写操作共用同一条失败路径：写失败不吞掉——吞掉的话用户点了删除/保存,
  // 什么都没发生,连个错误都看不到,以为是自己没点中。成功时顺带清掉上一条旧错误。
  const runMutation = React.useCallback(
    async (fn: () => Promise<unknown>) => {
      const revision = mutationErrorRevision.current;
      try {
        await fn();
        if (revision === mutationErrorRevision.current) setMutationError(null);
      } catch {
        mutationErrorRevision.current += 1;
        setMutationError(t("org.errors.generic"));
      }
    },
    [t],
  );

  // 新建超时（F5）：请求可能已经写进去了。一行提示 + 「刷新看看」——先重读整份名单，
  // 认出刚提交的那条就直接打开，认不出才允许再提交。基线取自内存里已有的那份 chart
  // （不另发读），所以提交本身不等任何读；提交时 POST 与之后的一切都不被基线拖慢。
  type PendingCreate = {
    kind: "agent" | "department";
    fields: AgentFields | DepartmentFields;
    knownBefore: ReadonlySet<string>;
    phase: "timeout" | "notFound" | "refreshFailed";
  };
  const [createNotice, setCreateNoticeState] =
    React.useState<PendingCreate | null>(null);
  const createNoticeRef = React.useRef<PendingCreate | null>(null);
  const setCreateNotice = (next: PendingCreate | null) => {
    createNoticeRef.current = next;
    setCreateNoticeState(next);
  };
  const refreshRef = React.useRef<Promise<boolean> | null>(null);
  const refreshCreated = (): Promise<boolean> => {
    if (refreshRef.current) return refreshRef.current;
    const pending = createNoticeRef.current;
    if (!pending) return Promise.resolve(false);
    const run = (async () => {
      let fresh: OrgChartResponse;
      try {
        fresh = await api<OrgChartResponse>("/v1/workspace/org");
      } catch {
        setCreateNotice({ ...pending, phase: "refreshFailed" });
        return false;
      }
      const found =
        pending.kind === "agent"
          ? writes.findCreatedAgent(
              fresh,
              pending.fields as AgentFields,
              pending.knownBefore,
            )
          : writes.findCreatedDepartment(
              fresh,
              pending.fields as DepartmentFields,
              pending.knownBefore,
            );
      if (!found) {
        setCreateNotice({ ...pending, phase: "notFound" });
        return false;
      }
      setCreateNotice(null);
      await reload();
      setSelection({ kind: pending.kind, syncId: found.sync_id });
      return true;
    })().finally(() => {
      refreshRef.current = null;
    });
    refreshRef.current = run;
    return run;
  };
  /** 提交一次新建；返回 false 表示这次提交作罢（上一次其实已经建好了）。 */
  const createWithRecovery = async (
    kind: PendingCreate["kind"],
    fields: AgentFields | DepartmentFields,
    write: () => Promise<{ sync_id: string }>,
  ) => {
    // 刷新在途、或上一次超时还没核实：先等核实；认出来了就不再发 POST。核实的那次读
    // 本身失败（refreshFailed）仍是「不知道建没建」，也不发——找不到才允许再提交（F5）。
    if (refreshRef.current && (await refreshRef.current)) return;
    const unverified = () => {
      const phase = createNoticeRef.current?.phase;
      return phase === "timeout" || phase === "refreshFailed";
    };
    if (unverified() && (await refreshCreated())) return;
    if (unverified()) return;
    const knownBefore = new Set<string>([
      ...(chart?.agents ?? []).map((a) => a.sync_id),
      ...(chart?.departments ?? []).map((d) => d.sync_id),
    ]);
    let res: { sync_id: string };
    try {
      res = await write();
    } catch (err) {
      if (err instanceof ApiTimeoutError) {
        setCreateNotice({ kind, fields, knownBefore, phase: "timeout" });
        return;
      }
      throw err;
    }
    setCreateNotice(null);
    await reload();
    setSelection({ kind, syncId: res.sync_id });
  };

  // 队列归页面而不是详情：关闭再打开同一行，也不能让新提交抢在旧提交前落库。
  const fieldQueue = React.useRef(Promise.resolve());
  const currentSelection = React.useRef(selection);
  React.useLayoutEffect(() => {
    currentSelection.current = selection;
  }, [selection]);
  const runFieldUpdate = (fn: () => Promise<void>) => {
    const revision = mutationErrorRevision.current;
    const write = fieldQueue.current.then(async () => {
      await fn();
      // 新操作成功可清掉已知错误；先前排队的成功不能吞掉后来才出现的错误。
      if (revision === mutationErrorRevision.current) setMutationError(null);
    });
    fieldQueue.current = write.catch((error) => {
      // 原来的详情已卸载时，其局部保存态不再可见，由页面报告失败。
      if (currentSelection.current !== selection) {
        mutationErrorRevision.current += 1;
        setMutationError(
          transportFailureText(error) ??
            errorText(error, t("org.errors.generic")),
        );
      }
    });
    return write;
  };

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

  /**
   * 首屏的两档非稳态。**两列共用**，因为它们说的是同一件事：整份组织架构是一次性
   * 拉全的，没到就是两列都没到。
   *
   * 此前 `loading && !chart` 只守了索引列，详情列照样走到最后一档——带
   * `/org/agent/<sync>` 的深链接（这条路径就是为深链接设计的）会先看到「没选中任何
   * 一行，来新建吧」，一句在那一刻确定为假的话；移动端更糟：有 selection 时索引列
   * 整个不渲染，那唯一一处 loading 提示也不存在。
   *
   * 失败同理：空的 models 画出来就是「还没有任何部门 / 新建一个部门开始」，用户可能
   * 据此去建一个已经存在的部门。
   */
  const initialLoading = loading && !chart;
  const initialFailed = error !== null && !chart;

  // 同一条错误，两个落点：索引底部（桌面、以及移动端回到索引后）与详情头下方
  // （移动端正看详情时，见下面传给两个详情组件的 alert 槽）。落点由「当前这一屏
  // 是哪个」决定，不是两处都画——两列在移动端本就一次只挂一个（showIndex /
  // showDetail），所以只要各自的宿主只在自己那一档渲染这条文案，就天然不会重复。
  const createNoticeNode: React.ReactNode = createNotice ? (
    <span className="flex flex-wrap items-center gap-2">
      <span>
        {createNotice.phase === "notFound"
          ? t("org.errors.createNotFound")
          : createNotice.phase === "refreshFailed"
            ? t("org.errors.createRefreshFailed")
            : t("org.errors.createTimeout")}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={isMobile ? "min-h-11" : undefined}
        onClick={() => void refreshCreated()}
      >
        {t("org.errors.createRefresh")}
      </Button>
    </span>
  ) : null;
  // 读失败（规格 G1）：原因与出口由 describeFailure 分类——原位一行 + 重试（手机 44px），
  // 401 给「重新登录」；原文只进「复制诊断信息」。首次失败与「已有数据时刷新失败」同一句。
  const loadFailureNotice =
    error !== null ? (
      <FailureNotice
        failure={describeFailure(failure, {
          t,
          what: t("org.errors.loadFailedWhat"),
        })}
        onRetry={() => void reload()}
      />
    ) : null;
  const alertMessage: React.ReactNode = initialFailed ? null : error ? (
    <span className="flex flex-wrap items-center gap-2">
      {loadFailureNotice}
    </span>
  ) : (
    createNoticeNode || mutationError || null
  );
  // 只在移动端且真的在看详情（不是骨架/失败态）时才递下去——两个详情组件把它摆在
  // 自己的头部下方（OrgDetailHeader 之后、正文之前）；桌面端不传，桌面的这条错误
  // 只在索引底部那一处出现，形态不变。
  const detailAlert =
    isMobile && alertMessage ? (
      <p role="alert" className="p-2.5 text-2xs text-destructive-text">
        {alertMessage}
      </p>
    ) : undefined;

  // 索引列 320px（mockup `.index`）直接落在外框（bg-chrome）上，不画自己的底色
  // 与右边线：行与组头的选中面是 bg-raised，就是照外框这个底调的。桌面经外壳的
  // `index` 槽摆到内容页左侧；移动端外壳不渲染它，它自己当整页（宽度交出去）。
  const indexColumn = showIndex ? (
    <div
      data-testid="org-index-col"
      className={cn(
        "flex min-w-0 flex-col",
        isMobile ? "min-h-0 flex-1" : "w-[320px] shrink-0",
      )}
    >
      {initialFailed ? (
        <div
          data-testid="org-index-failed"
          className="flex flex-wrap items-center gap-2.5 p-4 text-sm text-muted-foreground"
        >
          {loadFailureNotice}
        </div>
      ) : initialLoading ? (
        <OrgIndexSkeleton />
      ) : (
        <OrgIndexPanel
          departments={models.departments}
          agents={models.agents}
          backends={backends}
          agentBySync={models.agentBySync}
          maps={models.maps}
          selection={numericSelection}
          onSelect={handleSelect}
          isMobile={isMobile}
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
      {alertMessage && (
        <p role="alert" className="p-2.5 text-2xs text-destructive-text">
          {alertMessage}
        </p>
      )}
    </div>
  ) : null;

  return (
    /* 两栏要顶到主区的四条边，所以壳整块交出来（flush，与 Chat / Issues 同）。
       此前是壳照常留 padding、这里再用 `-mx-4 -my-5` 去抵消：横向凑巧对得上，
       纵向不行——`h-full` 量的是 main 的**内容盒**（已扣掉上下 padding），整块再
       上移一个 padding，底边就停在内容区底部往上两个 padding 处，页面底部空出
       一条与 padding 同色的白带（1440×900 实测 48px）。两列自己都在滚
       （OrgIndexPanel / 两个详情），交出 overflow 是安全的。 */
    <AppShell
      title={t("org.pageTitle")}
      flush
      // 手机上 Agent / 部门详情自己就是页头「‹ · 名字 · •••」（规格 2026-11-05「Agent
      // 与组织」；部门 2026-11-20 第 1 项）：壳的「‹ · 组织」顶栏不再叠在它上面。
      ownHeader={
        isMobile &&
        Boolean(
          (selectedAgent && selectedAgentModel) ||
          (selectedDepartment && selectedDepartmentModel),
        )
      }
      right={
        isMobile && !selection ? (
          <OrgAddMenu
            onCreateAgent={() => openCreateAgent("")}
            onCreateDepartment={() => openCreateDepartment("")}
          />
        ) : undefined
      }
      index={isMobile ? undefined : indexColumn}
    >
      <div
        data-testid="org-layout"
        className={cn(
          // 桌面：索引列由外壳摆在外框上（`index` 槽），这里只剩详情这一页。
          // 窄屏没有并排的空间（mockup `11-mobile.png`）：外壳不渲染 `index`，
          // 一次只摆一页——索引升整页，点一行下钻到详情，返回回索引。
          "flex h-full min-h-0 min-w-0 flex-col",
        )}
      >
        {isMobile && indexColumn}

        {showDetail && (
          <div
            data-testid="org-detail-col"
            // 父容器是 flex-col（桌面索引列已交给外壳的 `index` 槽，这里只剩详情；
            // 移动端一次只摆一页）：不给 min-h-0，这一列的默认 min-height:auto 会
            // 顶开父容器（内容多高它就多高），详情自己的 overflow-y-auto 反而不起作用。
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {initialFailed ? (
              <div
                data-testid="org-detail-failed"
                className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center gap-2.5 p-6 text-sm text-muted-foreground"
              >
                {loadFailureNotice}
              </div>
            ) : initialLoading ? (
              <OrgDetailSkeleton />
            ) : selectedAgent && selectedAgentModel ? (
              <OrgAgentDetail
                // key 隔离每个 Agent 的草稿、在途值与保存态，切到 Bob 时不携带
                // Alice 尚未提交的输入或失败重试。
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
                onBack={isMobile ? () => back("/org") : undefined}
                onClose={() => setSelection(null)}
                alert={detailAlert}
              />
            ) : selectedDepartment && selectedDepartmentModel ? (
              <OrgDepartmentDetail
                key={selectedDepartment.sync_id}
                department={selectedDepartment}
                departmentModel={selectedDepartmentModel}
                agents={models.agents}
                departments={models.departments}
                maps={models.maps}
                alert={detailAlert}
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
                onBack={isMobile ? () => back("/org") : undefined}
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
        onCreate={({ name, description, icon, color }) => {
          setCreateDeptOpen(false);
          // 组头的 ⋮ 进来时是子部门；空态进来时不带这个键（不是空串——空串是
          // 「显式挂到根上」这个值，与「这次请求没提到」不同，见 types.ts）。
          const fields: DepartmentFields = {
            name,
            ...(description ? { description } : {}),
            ...(icon ? { icon } : {}),
            ...(color ? { accent_color: color } : {}),
            ...(createDeptParentSync
              ? { parent_sync_id: createDeptParentSync }
              : {}),
          };
          void runMutation(() =>
            createWithRecovery("department", fields, () =>
              writes.createDepartment(fields),
            ),
          );
        }}
      />
      <CreateAgentDialog
        open={createAgentOpen}
        onOpenChange={setCreateAgentOpen}
        departments={chart?.departments ?? []}
        defaultDepartmentSyncId={createAgentDeptSync}
        onCreate={({ name, description, icon, color }, departmentSyncId) => {
          setCreateAgentOpen(false);
          const fields: AgentFields = {
            name,
            ...(description ? { description } : {}),
            ...(icon ? { avatar_icon: icon } : {}),
            ...(color ? { avatar_color: color } : {}),
            department_sync_id: departmentSyncId || undefined,
          };
          void runMutation(() =>
            createWithRecovery("agent", fields, () =>
              writes.createAgent(fields),
            ),
          );
        }}
      />
    </AppShell>
  );
}
