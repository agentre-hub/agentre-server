import { Button, SearchInput } from "@agentre-hub/agentre-ui";
import { RotateCw, TriangleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import SessionIndex from "@/components/session/SessionIndex";
import { loadErrorText } from "@/lib/loadError";
import type { IndexAxis, ProjectNode } from "@/lib/sessionAxes";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import type { SessionFilter } from "@/lib/sessionView";
import type { IndexView } from "@/pages/chat/chatRows";
import type { MachineReachability } from "@/pages/chat/useMachineReachability";
import type { ProjectManagement } from "@/pages/chat/useProjectManagement";
import type { SessionIndexData } from "@/pages/chat/useSessionIndex";

type SessionIndexProps = ComponentProps<typeof SessionIndex>;

/**
 * 这一次取数**有结论了**——成功或失败都算。索引的外壳（轴选择器、筛选 chips、
 * 搜索框）据此渲染：它们回答的是各自的问题，不该陪着行一起消失（决策 14）。
 */
export function indexSettled(sessionIndex: SessionIndexData): boolean {
  return sessionIndex.loaded || !!sessionIndex.loadError;
}

// 主空态说的是「你还没有对话」，判据因此是**账号里**一条都没有，而不是这次
// 搜索/筛选下一条都不剩——后者由索引自己那句「没有匹配这次搜索」承接。
//
// 分组轴的权威名单本身也是答案：机器 / 项目 / Agent 任一名单非空时，空组及其组头
// 仍要展示。项目轴的随手对话组是常驻兜底，不算一个已知项目；项目数为 0 且没有会话
// 时仍走页面真空态。时间轴没有权威空组，零会话始终走页面真空态。
export function isAccountEmpty(input: {
  accountTotal: number | null;
  axis: IndexAxis;
  machineCount: number;
  projectCount: number;
  agentCount: number;
}): boolean {
  if (input.accountTotal !== 0) return false;

  switch (input.axis) {
    case "machine":
      return input.machineCount === 0;
    case "project":
      return input.projectCount === 0;
    case "agent":
      return input.agentCount === 0;
    case "time":
      return true;
  }
}

/* 真实搜索：判据在服务端（决策 8，只按标题）。两处形态共用一份，只差尺寸。 */
export function ChatSearchField({
  size,
  value,
  onChange,
}: {
  size: "sm" | "md";
  value: string;
  onChange: (q: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <SearchInput
      size={size}
      value={value}
      onChange={onChange}
      aria-label={t("chat.searchSessions")}
      placeholder={t("chat.searchSessions")}
      className="min-w-0 flex-1"
    />
  );
}

/*
  TopBar 只剩「桌面端已连接」这一样（取不到就隐藏，不谎报）。另外两样去掉了：

  - 那个**没有标签的裸数字**：读者认不出它说的是「这个账号有几条对话」，
    放到导航项右侧又会被误读成未读数，因此不再渲染。`accountTotal` 仍只用于第一次保存
    判断与保存 / 删除的乐观更新。
  - 「去设备上找对话」：它指向 /devices 再下钻，而**机器轴就在这一页**回答同一个
    问题——选中一台在线机器，索引直接从那台机器实时拉清单，没进账号的行尾就是
    「保存」。留着它是让人绕一次路去做同一件事。索引的机器组头上现在有
    「在这台机器上找」，那才是这个入口该在的位置。
*/

/**
 * 索引这一栏：取数失败的横幅 + `SessionIndex` 本身。
 *
 * 数据层（`useSessionIndex`）与机器可达性（`useMachineReachability`）两族整份递进来，
 * 而不是把它们各自的字段拆成三十来个 prop——这一栏是它们**唯一**的去处，拆开只是把
 * 同一批名字在两个文件里各写一遍。轴、筛选、行投影结果这些由页面在两族之间算出来的
 * 东西才单独给。
 */
export interface ChatIndexPanelProps {
  sessionIndex: SessionIndexData;
  reach: MachineReachability;
  axis: IndexAxis;
  onAxisChange: (next: IndexAxis) => void;
  filter: SessionFilter;
  onFilterChange: (next: SessionFilter) => void;
  view: IndexView;
  selectedKey: string | null;
  /** 移动端下钻走路由，因此不给这一条（行自己是链接）。 */
  onSelect?: (row: MirrorIndexRow) => void;
  projects: ProjectNode[];
  agents: SessionIndexProps["agents"];
  groupTotals: Record<string, number>;
  loadGroupPage: SessionIndexProps["loadGroupPage"];
  projectManagement: ProjectManagement;
  /** Agent 组头上那颗 ＋ 的去处：直接开这个 Agent 的草稿。 */
  onAgentNewSession: (agentSyncId: string) => void;
  /** 当前机器范围镜像尚未完成时，所有在线组保持 pending，不消费上一范围快照。 */
  machineRangePending: boolean;
  /** 「已知的可见变化」3：移动端行尾保留本地化的状态文字徽标。 */
  rowStatusLabel: boolean;
  /**
   * 一条会话的地址（`/chat/:conversationId`，见 lib/sessionAddress）。它继承页面此刻
   * 的索引范围，因此由页面给。**引用要稳**：SessionIndex 的 renderRow 与 openRow 都
   * 把它列在依赖里，每次渲染换一个引用会让索引里所有行的 JSX 整片重造，而 Chat 的
   * 渲染很密（搜索框每敲一个字、每条 mirror_changed 信号）。
   */
  sessionPath: SessionIndexProps["sessionPath"];
}

export function ChatIndexPanel({
  sessionIndex,
  reach,
  axis,
  onAxisChange,
  filter,
  onFilterChange,
  view,
  selectedKey,
  onSelect,
  projects,
  agents,
  groupTotals,
  loadGroupPage,
  projectManagement,
  onAgentNewSession,
  machineRangePending,
  rowStatusLabel,
  sessionPath,
}: ChatIndexPanelProps) {
  const { t } = useTranslation();
  const machineStates: SessionIndexProps["machineStates"] =
    machineRangePending && axis === "machine"
      ? Object.fromEntries(
          reach.onlineMachines.map((machine) => [machine.id, "connecting"]),
        )
      : reach.machineStates;

  /** 索引取数失败给用户看的那一句：服务端带了文案就用它，没有才落到兜底键。 */
  const indexErrorMessage = sessionIndex.loadError
    ? loadErrorText(sessionIndex.loadError, t, "device.manage.loadError")
    : null;

  /**
   * 索引这一次没取回来（规格 2026-08-21 决策 14）。
   *
   * 此前它 `return` 掉整页：侧栏还在，内容区一无所有，连个重试都没有，只能刷新
   * 浏览器。可失败的只是「列哪些行」这一件事——轴选择器、筛选 chips、搜索框都还
   * 答得出各自的问题，没有理由陪葬。
   */
  const indexError = sessionIndex.loadError ? (
    <div
      role="alert"
      data-testid="index-load-error"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/35 bg-destructive-soft px-3 py-2.5 text-[12.5px] text-destructive-text"
    >
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{indexErrorMessage}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          // 清掉再重取：横幅留着的话，这一次成功了它也还挂在那儿。
          sessionIndex.setLoadError(null);
          sessionIndex.refetch();
        }}
      >
        <RotateCw aria-hidden="true" className="size-3.5" />
        {t("sessionIndex.loadMore.retry")}
      </Button>
    </div>
  ) : null;

  /**
   * 上一次保存没写成（规格 2026-08-18 决策 2 的收尾动作失败时）。
   *
   * 与上面那条取数横幅同形、同一处落位，因为它们说的是同一类事实：**左栏这份列表
   * 此刻不完整，原因在这里，出路在这里**。此前这两条路都是空 catch —— 手动保存的
   * 行闪一下撤回、发起即保存干脆一声不吭，而后者的画面（右栏开着、左栏没有）与
   * 「这条对话根本没开起来」无法区分。
   *
   * 它不吃掉列表：账号里已经有的那些照常列着，失败的只是新加进去这一条。
   */
  const saveFailure = sessionIndex.saveFailure;
  const saveError = saveFailure ? (
    <div
      role="alert"
      data-testid="index-save-error"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/35 bg-destructive-soft px-3 py-2.5 text-[12.5px] text-destructive-text"
    >
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {t(`sessionIndex.saveFailed.${saveFailure.kind}`, {
          title: saveFailure.title,
        })}
      </span>
      <Button variant="outline" size="sm" onClick={sessionIndex.retrySave}>
        <RotateCw aria-hidden="true" className="size-3.5" />
        {t("sessionIndex.saveFailed.retry")}
      </Button>
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      {indexError}
      {saveError}
      <SessionIndex
        axis={axis}
        onAxisChange={onAxisChange}
        rows={view.rows}
        projects={projects}
        agents={agents}
        machines={reach.machines}
        machineStates={machineStates}
        onSave={sessionIndex.onSave}
        onDelete={sessionIndex.askDelete}
        // 「已知的可见变化」3：移动端行尾保留本地化的状态文字徽标。
        rowStatusLabel={rowStatusLabel}
        narrowed={view.narrowed}
        filter={filter}
        onFilterChange={onFilterChange}
        unreadCount={sessionIndex.unreadTotal}
        // 空态要说得出「东西还在，只是这一档不收」，也要给得出回程（决策 12）。
        accountTotal={sessionIndex.accountTotal ?? undefined}
        machineNotes={reach.machineNotes}
        onRetryMachine={reach.retryMachine}
        onClearSearch={() => sessionIndex.setSearchQuery("")}
        groupTotals={groupTotals}
        loadGroupPage={loadGroupPage}
        overflowRangeKey={`${axis}|${sessionIndex.debouncedSearch}|${filter}`}
        hasMore={sessionIndex.hasMore}
        loadingMore={sessionIndex.loadingMore}
        loadMoreFailed={sessionIndex.loadMoreFailed}
        onLoadMore={sessionIndex.loadMore}
        selectedKey={selectedKey}
        onSelect={onSelect}
        projectHandlers={projectManagement.handlers}
        // 建**顶层**项目：父项目留空（规格 2026-08-21-root-project-entry 决策 3）。
        // 组头菜单那条「新建子项目…」覆盖的是「往某个项目底下建」，这一颗补的
        // 正是它覆盖不到的那一半——账号里一个项目都没有时的第一个，以及与现有
        // 项目平级的那种。
        onNewProject={projectManagement.openCreate}
        // Agent 轴上「在这一组里开一条」：项目组头的 ＋ 还要先挑成员，这里那一维
        // 本来就定了，因此直接落到草稿。
        onAgentNewSession={onAgentNewSession}
        sessionPath={sessionPath}
      />
    </div>
  );
}
