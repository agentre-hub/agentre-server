/**
 * 组织索引的工具条 + 列表体：与桌面端同形（规格「索引」），组件本身来自共享包
 * （`OrgGroupHeader` / `OrgAgentRow`），只有工具条的那一个筛选入口 + chips 行 +
 * 无结果块 + 空部门块 + 组头右侧那两个动作是宿主自己搭的——包的 `ui/` 里没有
 * DropdownMenu，动作语义包也刻意不硬编码，这一段规格本就说「外壳保持分叉」。
 *
 * 组的折叠态也归这里：包的组头只画三角、把点击原样发回来，谁被收起来、收起来之后
 * 哪些行还渲染，都是宿主的事。
 *
 * 不带拖拽：web 组织面不排 Agent/部门顺序（规格「web 组织面能管的是」只把「排序」
 * 列给了执行目标），落点判据 / 拖拽绑定因此都不需要，移动端的等价物（详情的
 * 「归属」下拉）本就一直存在。
 */
import * as React from "react";
import {
  Check,
  ChevronDown,
  CornerDownRight,
  FolderPlus,
  MoreVertical,
  Plus,
  Server,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
  buildOrgIndex,
  buildOrgReportsToOptions,
  OrgAgentRow,
  SearchInput,
  OrgGroupHeader,
  type OrgAgentModel,
  type OrgDepartmentModel,
  type OrgIndexGroup,
  type OrgSelection,
} from "@agentre-hub/agentre-ui";

import { filterRowsByBackend, type OrgIdMaps } from "./adapter";
import type { OrgAgentItem, OrgBackendItem } from "./types";

export interface OrgIndexPanelProps {
  departments: OrgDepartmentModel[];
  agents: OrgAgentModel[];
  backends: OrgBackendItem[];
  agentBySync: Map<string, OrgAgentItem>;
  maps: OrgIdMaps;
  selection: OrgSelection;
  onSelect: (selection: OrgSelection) => void;
  /** 不带 id = 顶层部门；带 id = 挂在那个部门下的子部门。 */
  onCreateDepartment: (parentDepartmentId?: number) => void;
  /** 不带 id = 由对话框自己挑部门；带 id = 直接落在那个部门里。 */
  onCreateAgent: (departmentId?: number) => void;
}

export function OrgIndexPanel(props: OrgIndexPanelProps) {
  const { t } = useTranslation();
  const { departments, agents, backends, agentBySync, maps } = props;

  const [search, setSearch] = React.useState("");
  const [backendSyncId, setBackendSyncId] = React.useState("");
  const [reportsToId, setReportsToId] = React.useState(0);
  // 收起哪些部门归宿主（共享包的组头只画三角、把点击原样发回来，见它的
  // onToggleExpanded 注释）。默认全展开：一进来就看见全貌，收起是用户做的减法。
  // 按**部门数字 id** 记，而那套 id 每份快照各自分配（见 adapter.ts 顶部）——刷新
  // 后同一个部门的 id 可能变，折叠态跟着复位，这比记错了折叠别人要好。
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );
  const toggleCollapsed = React.useCallback((departmentId: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(departmentId)) next.add(departmentId);
      return next;
    });
  }, []);

  const filters = React.useMemo(
    () => ({ search, backendId: 0, reportsToId }),
    [search, reportsToId],
  );
  const model = React.useMemo(
    () => buildOrgIndex({ agents, departments, filters }),
    [agents, departments, filters],
  );
  const reportsToOptions = React.useMemo(
    () => buildOrgReportsToOptions(agents, departments),
    [agents, departments],
  );

  const topRows = React.useMemo(
    () => filterRowsByBackend(model.topRows, backendSyncId, agentBySync, maps),
    [model.topRows, backendSyncId, agentBySync, maps],
  );
  const matchedGroups = React.useMemo(
    () =>
      model.groups.map((group) => ({
        ...group,
        rows: filterRowsByBackend(group.rows, backendSyncId, agentBySync, maps),
      })),
    [model.groups, backendSyncId, agentBySync, maps],
  );
  // 收起一个部门连它的子部门一起收走：groups 是 DFS 前序 + depth，遇到收起的那一个
  // 就把后面所有更深的组跳掉——只收一层会让子部门浮在收起的父部门下面。与桌面端
  // org-index.tsx 的 visibleGroups 同一条。
  //
  // 这一层刻意在 matchedGroups **之后**：命中数（下面的 noMatch）要按筛选结果算，
  // 不能把用户自己折起来的行也算成「没找到」——那会在收完所有组之后弹出一块
  // 「未找到 Agent」，而它们只是被收起来了。
  const groups = React.useMemo(() => {
    const visible: OrgIndexGroup[] = [];
    let hiddenBelow = -1;
    for (const group of matchedGroups) {
      if (hiddenBelow >= 0 && group.depth > hiddenBelow) continue;
      hiddenBelow = -1;
      visible.push(
        collapsed.has(group.department.id) ? { ...group, rows: [] } : group,
      );
      if (collapsed.has(group.department.id)) hiddenBelow = group.depth;
    }
    return visible;
  }, [matchedGroups, collapsed]);

  const backendName =
    backends.find((b) => b.sync_id === backendSyncId)?.name ?? "";
  const reportsToName =
    reportsToOptions.find((a) => a.id === reportsToId)?.name ?? "";

  const conditions = [
    search.trim()
      ? { key: "search", label: search.trim(), clear: () => setSearch("") }
      : null,
    backendSyncId
      ? {
          key: "backend",
          label: t("org.index.filters.backendLabel", { name: backendName }),
          clear: () => setBackendSyncId(""),
        }
      : null,
    reportsToId > 0
      ? {
          key: "reportsTo",
          label: t("org.index.filters.reportsToLabel", { name: reportsToName }),
          clear: () => setReportsToId(0),
        }
      : null,
  ].filter((c): c is { key: string; label: string; clear: () => void } =>
    Boolean(c),
  );
  const filterChips = conditions.filter((c) => c.key !== "search");
  const clearAll = () => {
    setSearch("");
    setBackendSyncId("");
    setReportsToId(0);
  };

  const visibleCount =
    topRows.length + matchedGroups.reduce((sum, g) => sum + g.rows.length, 0);
  const noMatch = visibleCount === 0 && conditions.length > 0;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-slot="org-index">
      {/* 工具条只有一行：搜索框 + **一个**筛选入口 + ＋（决策 12「筛选不常驻占位」，
          mockup `.idx-search` 也是这三样）。命中之后才多出下面那排可清除的 chip。 */}
      <div
        className="flex shrink-0 flex-col gap-2 border-b border-sidebar-border p-2.5"
        data-testid="org-index-toolbar"
      >
        <div className="flex items-center gap-1.5">
          <SearchInput
            variant="muted"
            value={search}
            onChange={setSearch}
            aria-label={t("org.index.searchAria")}
            placeholder={t("org.index.searchPlaceholder")}
            className="min-w-0 flex-1"
          />
          <FilterEntry
            activeCount={filterChips.length}
            allLabel={t("org.index.filters.all")}
            label={t("org.index.filters.entry")}
            ariaLabel={t("org.index.filters.entryAria")}
            sections={[
              {
                key: "backend",
                heading: t("org.index.filters.backendAria"),
                icon: <Server className="size-3.5" aria-hidden="true" />,
                value: backendSyncId,
                onValueChange: setBackendSyncId,
                options: backends.map((b) => ({
                  value: b.sync_id,
                  label: b.name ?? b.sync_id,
                })),
              },
              {
                key: "reportsTo",
                heading: t("org.index.filters.reportsToAria"),
                icon: (
                  <CornerDownRight className="size-3.5" aria-hidden="true" />
                ),
                value: reportsToId > 0 ? String(reportsToId) : "",
                onValueChange: (v) => setReportsToId(Number(v)),
                options: reportsToOptions.map((a) => ({
                  value: String(a.id),
                  label: a.name,
                })),
              },
            ]}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("org.index.newAgent")}
            title={t("org.index.newAgent")}
            onClick={() => props.onCreateAgent()}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {filterChips.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-testid="org-index-chips"
          >
            {filterChips.map((condition) => (
              <button
                key={condition.key}
                type="button"
                aria-label={t("org.index.filters.clear", {
                  label: condition.label,
                })}
                onClick={condition.clear}
                className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary-soft px-2 py-0.5 font-mono text-2xs text-primary-text"
              >
                <span>{condition.label}</span>
                <X className="size-3" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 行与组头是**内缩的圆角块**而不是通栏条，所以左右内缩由这一层给
          （mockup `.rows { padding: 2px 6px 8px }`）——包里的行只管自己那点内边距，
          少了这一层圆角就贴着边框，内缩形态白做。 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-0.5"
        data-slot="org-index-body"
      >
        {noMatch ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <span className="text-sm text-muted-foreground">
              {t("org.index.noMatch.title")}
            </span>
            <span
              className="font-mono text-2xs text-muted-foreground"
              data-testid="org-index-no-match-conditions"
            >
              {t("org.index.noMatch.conditions", {
                conditions: conditions.map((c) => c.label).join(" · "),
              })}
            </span>
            <Button variant="outline" size="sm" onClick={clearAll}>
              {t("org.index.filters.clearAll")}
            </Button>
          </div>
        ) : (
          <>
            {topRows.map((row) => (
              <OrgAgentRow
                key={row.agent.id}
                row={row}
                indent={0}
                selected={
                  props.selection?.kind === "agent" &&
                  props.selection.id === row.agent.id
                }
                onSelect={props.onSelect}
              />
            ))}
            {groups.map((group) => (
              <React.Fragment key={group.department.id}>
                <OrgGroupHeader
                  group={group}
                  selected={
                    props.selection?.kind === "department" &&
                    props.selection.id === group.department.id
                  }
                  onSelect={props.onSelect}
                  expanded={!collapsed.has(group.department.id)}
                  onToggleExpanded={() => toggleCollapsed(group.department.id)}
                  actions={
                    <GroupActions
                      department={group.department}
                      onCreateAgent={props.onCreateAgent}
                      onCreateDepartment={props.onCreateDepartment}
                    />
                  }
                />
                {group.rows.map((row) => (
                  <OrgAgentRow
                    key={row.agent.id}
                    row={row}
                    // 行缩在自己的部门头下一级：索引里唯一的层级是「部门套部门」，
                    // 与组头同级的话两者挤在同一条左缘，读不出这一行属于谁。
                    indent={group.depth + 1}
                    selected={
                      props.selection?.kind === "agent" &&
                      props.selection.id === row.agent.id
                    }
                    onSelect={props.onSelect}
                  />
                ))}
              </React.Fragment>
            ))}
            {departments.length === 0 && (
              <div
                className="m-2.5 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center"
                data-slot="org-index-empty-departments"
              >
                <span className="text-sm font-semibold">
                  {t("org.index.emptyDepartments.title")}
                </span>
                <span className="text-2xs text-muted-foreground">
                  {t("org.index.emptyDepartments.description")}
                </span>
                <div className="mt-1 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-2xs"
                    onClick={() => props.onCreateDepartment()}
                  >
                    <FolderPlus className="size-3" aria-hidden="true" />
                    {t("org.index.emptyDepartments.newDepartment")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-2xs"
                    onClick={() => props.onCreateAgent()}
                  >
                    <Plus className="size-3" aria-hidden="true" />
                    {t("org.index.emptyDepartments.addAgent")}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 组头右侧的动作（mockup 的 `＋` 与 `⋮`）。共享包刻意不硬编码任何动作语义——两端
 * 能做的事不同，它只留了 `actions` 这个口子（见 org-group-header.tsx 的注释）。
 *
 * 这里只画**本仓真的有写端点**的动作（`writes.ts`）：`＋` 建一个直接落在这个部门里
 * 的 Agent，`⋮` 建一个挂在它下面的子部门。删除不画：那条路径连着一个确认弹层，它
 * 现在住在部门详情里（`OrgDepartmentDetail`），在索引再搭一份就是同一件事的第二份
 * 实现——组头点一下就到详情，删除在那儿。
 *
 * 渲染在组头「选中」那个按钮**之外**：`<button>` 不能嵌 `<button>`。
 */
function GroupActions(props: {
  department: OrgDepartmentModel;
  onCreateAgent: (departmentId?: number) => void;
  onCreateDepartment: (parentDepartmentId?: number) => void;
}) {
  const { t } = useTranslation();
  const { department } = props;
  const actionClass =
    "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none";
  return (
    <>
      <button
        type="button"
        data-testid={`org-group-add-agent-${department.id}`}
        aria-label={t("org.index.newAgent")}
        title={t("org.index.newAgent")}
        onClick={() => props.onCreateAgent(department.id)}
        className={actionClass}
      >
        <Plus className="size-3" aria-hidden="true" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={`org-group-more-${department.id}`}
            aria-label={t("org.detail.header.more")}
            className={actionClass}
          >
            <MoreVertical className="size-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => props.onCreateDepartment(department.id)}
          >
            <FolderPlus className="size-3" aria-hidden="true" />
            {t("org.index.newDepartment")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

interface FilterMenuOption {
  value: string;
  label: string;
}

interface FilterSection {
  key: string;
  heading: string;
  icon: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  options: FilterMenuOption[];
}

// 筛选是**一个**入口，两维都收在里面：决策 12「筛选不常驻占位」点名否决了
// 「常驻两个下拉」——未筛选时它们既不说明用途也占掉一整行。命中之后说话的是
// 下面那排可清除的 chip。与桌面端同一条判据（两端同形）。
function FilterEntry(props: {
  activeCount: number;
  label: string;
  ariaLabel: string;
  allLabel: string;
  sections: FilterSection[];
}) {
  const active = props.activeCount > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="org-filter-entry"
          aria-label={props.ariaLabel}
          className={cn(
            // h-8 与搜索框、＋ 同高：三样现在同排（mockup 的 .field / .sq 也都是 30px），
            // 差一档就看得出来这一行没对齐。
            "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-2xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
            active
              ? "border-primary bg-primary-soft text-primary-text"
              : "border-border text-muted-foreground",
          )}
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          <span>{props.label}</span>
          {active ? (
            <span className="font-mono">{props.activeCount}</span>
          ) : null}
          <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-auto">
        {props.sections.map((section, index) => (
          <React.Fragment key={section.key}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="flex items-center gap-1.5 text-muted-foreground">
              {section.icon}
              {section.heading}
            </DropdownMenuLabel>
            <DropdownMenuItem
              data-testid={`org-filter-${section.key}-option-all`}
              onSelect={() => section.onValueChange("")}
            >
              {!section.value && (
                <Check className="size-3" aria-hidden="true" />
              )}
              {props.allLabel}
            </DropdownMenuItem>
            {section.options.map((option) => (
              <DropdownMenuItem
                key={option.value}
                data-testid={`org-filter-${section.key}-option-${option.value}`}
                onSelect={() => section.onValueChange(option.value)}
              >
                {section.value === option.value && (
                  <Check className="size-3" aria-hidden="true" />
                )}
                {option.label}
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
