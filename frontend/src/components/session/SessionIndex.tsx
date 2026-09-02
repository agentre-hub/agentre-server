import {
  AgentGroupHeader,
  AxisPicker,
  buildAxisGroups,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  FreeGroupHeader,
  ImportLocalSessionMenu,
  ImportSessionDialog,
  MachineGroupHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProjectGroupHeader,
  ProjectHeaderActions,
  ProjectHeaderContextMenu,
  RowLeadingSlot,
  RowSecondaryLine,
  SessionGroup,
  SessionRow,
  UNKNOWN_MACHINE_KEY,
  type AgentInfo,
  type ImportDialogPrefill,
  type ImportOutcome,
  type MachineInfo,
  type ProjectHeaderActionsProps,
  type ProjectNode,
  Button,
  cn,
} from "@agentre-hub/agentre-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  CircleAlert,
  FolderPlus,
  ListX,
  LoaderCircle,
  MessagesSquare,
  SearchX,
  Trash2,
} from "lucide-react";

import { InlineEmpty } from "@/components/console";
import { useAliveEffect } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { createBrowserSessionImportPorts } from "@/lib/importPorts";
import type {
  MirrorIndexGroup,
  MirrorIndexGroupRow,
  MirrorIndexRow,
} from "@/pages/chat/chatRows";
import type { NewConvAgent } from "@/components/session/newconv/types";
import { INDEX_AXES, type IndexAxis } from "@/lib/sessionAxes";
import {
  deviceIdOfGroupKey,
  machineGroupKey,
  scopeOfGroup,
} from "@/lib/sessionScope";
import {
  formatRelativeTime,
  sessionStatusLabel,
  toAgentStatus,
  type SessionFilter,
} from "@/lib/sessionView";
import SessionListSkeleton from "@/components/session/SessionListSkeleton";

/**
 * 统一会话索引（规格 2026-08-17，数据源改镜像 2026-08-18）：一个列表、四个轴
 * （项目 / Agent / 时间 / 机器）。
 *
 * 分组本身是共享包 `@agentre-hub/agentre-ui` 的 `buildAxisGroups`（纯函数，单独测，
 * 规格 2026-08-18「共享包承载什么」两端共用同一份）；这里只管渲染与轴的切换。
 * `lib/sessionAxes` 只剩宿主自己的可选轴清单 `INDEX_AXES`（决策 17）。
 *
 * **行长什么样也全在包里**：行是 `SessionRow`，行首那一槽是 `RowLeadingSlot`、
 * 第二行是 `RowSecondaryLine`、轴选择器是 `AxisPicker`
 * （包 60e7d4d4「收下会话索引的契约、轴投影与六个呈现件」）。此前这几件本站各画
 * 了一份，于是同一条设计在两端长出两种样子——轴选择器丢了图标、第二行丢了
 * 「随手对话」那一维、字形的无障碍名整个没有。同一个记号只能有一份实现。
 *
 * **组头也一样**（包 3a49c1ee「四种组头收进同一个外壳」）：项目 / Agent / 机器 /
 * 随手对话四档分别是 `ProjectGroupHeader` / `AgentGroupHeader` /
 * `MachineGroupHeader` / `FreeGroupHeader`。此前本站手画了一份，于是同一格字形在
 * 桌面端是 24px、在这里是 16px，Agent 那一档干脆退化成一枚 8px 色点。
 *
 * 宿主这边还留着的只有「包不认识的东西」：组头上那些角标与动作（机器的连接档位 /
 * 离线 / 条数、项目动作）、筛选 chips、「查看全部 N」溢出层、保存与删除。
 *
 * **轴由宿主持有**，不是这个组件的内部状态：设备下钻重定向过来时要预置「机器轴 +
 * 选中该机器」，那件事只有路由那一层知道。
 *
 * 行上的两个动作（保存 / 删除）也只**报给宿主**：写请求、乐观更新与删除确认的
 * 文案都要知道账号与机器的状态，那些在宿主手里。
 */

/**
 * 筛选 chips 的顺序（规格「索引的组成」筛选与搜索）。跨四个轴同一套，因此摆在
 * 索引这一层而不是某个轴里。判据在服务端（规格 2026-08-19 决策 9），这一层只摆
 * chip 并把选中的那一档报给宿主。
 */
// 第三档是「未读」而不是「等你处理」：它有了自己的判据（migration 202608200001
// 的 last_read_at），与桌面端 attention-store 同一条。总览那条操作条摆的仍是
// 「等你处理」——两个页面问的本来就不是同一个问题。
const FILTER_CHIPS: SessionFilter[] = ["all", "running", "unread"];

/**
 * 行尾的最后活动时间。只在 daemon 报了 updatedAt 时渲染——老会话缺这一列时什么都
 * 不显示，不猜一个时刻（与退化标题同一条原则）。共享行把它摆在 `trailing` 槽里，
 * 因此是右对齐的（规格「已知的可见变化」第 2 条）。
 */
function LastActive({ ms, locale }: { ms: number; locale: string }) {
  // 三个格式化各自都不便宜(toLocaleString 内部还要现建一个 DateTimeFormat),而
  // 这个组件是**每行**一个:索引因搜索按键、兜底轮询、mirror_changed 信号整体重渲
  // 染时,200 行就是 600 次格式化。ms/locale 不变就一次都不用重算。
  const formatted = useMemo(() => {
    if (!ms) return null;
    const at = new Date(ms);
    return {
      dateTime: at.toISOString(),
      title: at.toLocaleString(),
      label: formatRelativeTime(ms, locale),
    };
  }, [ms, locale]);
  if (!formatted) return null;
  return (
    <time
      dateTime={formatted.dateTime}
      title={formatted.title}
      className="shrink-0 text-2xs text-muted-foreground"
    >
      {formatted.label}
    </time>
  );
}

/**
 * 机器轴上每台机器都要有自己的组头（规格 2026-08-21 决策 3）。
 *
 * 共享包的投影只给**有行的**机器出组（`axis-groups.js` 的「有会话的机器才出现」），
 * 而这一轴上「离线」与「这台机器上还没有对话」都得有一个组头去承载——机器整台从
 * 索引上消失的话，读者会把「机器不在了」读成「上面没有对话」。补出来的空组与包里
 * 那些同形，排序也照它那条：在线在前、离线沉底，同一档按名字。
 */
function withEveryMachine(
  groups: MirrorIndexGroup[],
  machines: MachineInfo[],
): MirrorIndexGroup[] {
  const present = new Set(groups.map((g) => g.key));
  const filled: MirrorIndexGroup[] = [
    ...groups,
    ...machines
      .filter((m) => !present.has(machineGroupKey(m.deviceId)))
      .map((m) => ({
        key: machineGroupKey(m.deviceId),
        kind: "machine" as const,
        label: m.name,
        depth: 0,
        offline: !m.online,
        rows: [],
      })),
  ];
  // 认不出机器的那一组不是一台机器，它永远排最后（包里也是这么摆的）。
  const rank = (g: MirrorIndexGroup) => (g.key === UNKNOWN_MACHINE_KEY ? 1 : 0);
  // 同名的两台机器按设备标识收尾，**比的是数**：包里那条是 `a.deviceId - b.deviceId`，
  // 这里拿组键的字符串比的话 `device-10` 会排到 `device-9` 前面——同一件事两个次序。
  const deviceId = (g: MirrorIndexGroup) => deviceIdOfGroupKey(g.key) ?? 0;
  return filled.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(a.offline) - Number(b.offline) ||
      a.label.localeCompare(b.label) ||
      deviceId(a) - deviceId(b),
  );
}

/**
 * 筛选 chips：全部 / 运行中 / 等你处理 N。跨四个轴一致，收窄的是**行**——一条都不
 * 剩的组头随之消失，因为分组是在收窄之后才做的（决策 10 的同一条规则）。
 *
 * 「等你处理」上那个数与当前选中哪一档无关（决策 3 只改名字，判据与计数照旧）：
 * 它说的是「还有几条在等你」，切到别的档不该让这句话变。
 */
function FilterChips({
  filter,
  unreadCount,
  onFilterChange,
}: {
  filter: SessionFilter;
  unreadCount: number;
  onFilterChange: (filter: SessionFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      data-testid="index-filter-chips"
      aria-label={t("sessionIndex.filter.title")}
      // shrink-0：与选择器同处一行时，宁可整块折到第二行，也不要被压窄到
      // 三个 chip 的文字各自截断。
      className="flex shrink-0 items-center gap-1"
    >
      {FILTER_CHIPS.map((option) => (
        <button
          key={option}
          type="button"
          data-testid={`filter-chip-${option}`}
          aria-pressed={filter === option}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium transition-colors",
            filter === option
              ? "bg-primary-soft text-primary-text"
              : "text-muted-foreground hover:bg-accent",
          )}
          onClick={() => onFilterChange(option)}
        >
          {t(`sessionIndex.filter.${option}`)}
          {/* 一条都不等你时不摆一个 0：空徽标比没有徽标更吵。 */}
          {option === "unread" && unreadCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-status-waiting px-1 text-3xs font-semibold text-status-waiting-foreground">
              {unreadCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * 行尾的「保存」（规格 2026-08-18 决策 5 / 11）。只出现在**还没进账号**的那些行上
 * ——机器轴选中一台在线机器时列出的那批。已经在账号里的行不摆任何动作：一列不会
 * 变的图标是纯噪声。
 *
 * 是**文字**不是图标：这个动作现在的意思是「把整条对话的内容存进我的账号」，
 * 藏在一枚书签里说不清楚。放在共享行的 `rowActions` 槽里——`<button>` 不能嵌在
 * `<a>` 里，它必须是链接的兄弟节点。
 */
function SaveButton({
  testId,
  onSave,
}: {
  testId: string;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const label = t("sessionIndex.row.save");
  return (
    <Button
      variant="ghost"
      size="xs"
      data-testid={testId}
      aria-label={label}
      title={label}
      className="shrink-0 bg-primary-soft text-primary-text hover:bg-primary-soft/80"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSave();
      }}
    >
      {label}
    </Button>
  );
}

/**
 * 行的右键菜单：删除（决策 6）。只有已保存的行才有——没保存过的对话账号里根本
 * 没有它，「删除」无从谈起。
 *
 * 用的是共享包的 ContextMenu 原语，但**不用** `SessionRow` 自带的那套菜单：那套
 * 固定摆三项（重命名 / 在新标签页打开 / 删除），前两件事这一端做不了，摆出来就是
 * 两个按了没反应的死项。
 */
function RowContextMenu({
  children,
  onDelete,
}: {
  children: React.ReactNode;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  if (!onDelete) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t("sessionIndex.row.menu")}>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" aria-hidden="true" />
          <span>{t("sessionIndex.row.delete")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * 一个组头进入导入对话框时预填哪一维（规格 2026-08-26 板 E）。
 *
 * 机器组头**进入即锁定那台机器**：导的是那台机器磁盘上的会话，导完也在那台机器上
 * 接着跑。Agent 组头预选那个 Agent —— 它带出后端与模型，底部那一步只剩确认。
 * 随手对话那一组不预填任何一维。
 */
function importPrefillOf(group: MirrorIndexGroup): ImportDialogPrefill {
  switch (group.kind) {
    case "machine": {
      const deviceId = deviceIdOfGroupKey(group.key);
      return deviceId === undefined
        ? { scopeLabel: group.label }
        : { scopeLabel: group.label, deviceId: String(deviceId) };
    }
    case "agent":
      // Agent 轴的组键就是 Agent 的同步标识（共享包 buildAxisGroups 的约定），
      // 而 ports 里每个 agent 的 id 也是它 —— 两者必须同源，否则预选选不中。
      return { scopeLabel: group.label, agentId: group.key };
    default:
      return { scopeLabel: group.label };
  }
}

function GroupHeader({
  group,
  state,
  note,
  count,
  onRetry,
  expanded,
  toggle,
  onExpandedChange,
  projectHandlers,
  onImport,
}: {
  group: MirrorIndexGroup;
  /** 这台机器的额外说明（最后在线）。 */
  note?: { lastSeenAt?: number };
  /** 这一组有几条。**已经答上来**的机器才给（含 0）——没答上来时它不成立。 */
  count?: number;
  /** 重新问一次这台机器。只有 `unreachable` 那一档给。 */
  onRetry?: () => void;
  /**
   * 机器轴上这台机器此刻的连接档位（规格 2026-08-21 决策 6）。N 台机器各有各的
   * 状态，一条页面级横幅说不了 N 件事，因此状态说在各自的组头上。`connected`
   * 时什么也不摆——正常不用说；离线由 `group.offline` 那枚徽标说。
   */
  state?: MachineConnectionState;
  /**
   * 项目组头上那三样动作要用的材料与去处（规格 2026-08-20）。宿主给才有——索引
   * 自己既不知道账号里有哪些 Agent，也不该替调用方决定「点了之后去哪」。
   */
  projectHandlers?: (projectSyncId: string) => ProjectHeaderActionsProps | null;
  /** 时间轴那一组没有组头，因此这两个只在可收放的轴上给。 */
  expanded?: boolean;
  toggle?: () => void;
  /**
   * 把这一组当前是展开还是收起报给索引。收放状态住在共享包的 `SessionGroup` 里
   * （它要落 localStorage），而 ↑↓ 的路线得知道哪些行现在看不见——这个回调是两者
   * 之间**唯一**的通路，索引因此不必自己再读一遍那份持久化状态。
   */
  onExpandedChange?: (key: string, expanded: boolean) => void;
  /**
   * 打开「导入本地会话」，带上这一组自己那一维的预填（规格 2026-08-26 决策 13）。
   * **不给就整条不出现**——这是能力开关，不是可选回调：置灰在说「你以后可以」，
   * 而没有这条通路的宿主永远不会有这个入口。
   */
  onImport?: (prefill: ImportDialogPrefill) => void;
}) {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    if (expanded !== undefined) onExpandedChange?.(group.key, expanded);
  }, [expanded, group.key, onExpandedChange]);
  // 项目组头的键就是项目同步标识（共享包 buildAxisGroups 的约定）。
  const base =
    group.kind === "project" ? (projectHandlers?.(group.key) ?? null) : null;
  /**
   * 项目组头本来就有一份 ⋮ 菜单，「导入本地会话…」插进那份全集里；其余轴的组头
   * 此前没有 ⋮，由下面那颗独立的菜单摆出来。两处的文案与图标只定义一次（都在包里）。
   *
   * 项目这一维**不预填**：本站按会话的工作目录就地判定项目归属（决策 12），而
   * 项目路径从不下行到浏览器（R19）——填不出 cwdPrefix，也不该拿一个猜的值去筛。
   */
  const handlers =
    base && onImport
      ? {
          ...base,
          onImportLocalSession: () => onImport({ scopeLabel: group.label }),
        }
      : base;

  /**
   * 机器那一维的角标。**跟着名字走**，因为它们说的是这一组本身的事。
   *
   * 这几样是本站独有的产品决定（规格 2026-08-21 决策 6/11），包里的组头只留了插槽：
   * 一台机器在线但答不上来、认得出但不在、认得出但版本太老，桌面端都没有对应的处境。
   */
  const badges = (
    <>
      {/*
        在线、但这一刻还答不出。两种处境分别说，而且**长得不一样**（规格
        2026-08-21-connection-failure-ux 决策 9）：

        - 连接中 = 在动。一枚转着的图标，不是一枚静止的灰标签——后者读起来像
          终态，而它几百毫秒后自己就变了。可见文字仍在（sr-only），状态不能
          只剩一个转圈的图形。
        - 连不上 = 出问题了。升到 status-waiting，与「在动」和「不在」分开；
          三档里只有它能靠用户动作改变，所以只有它长出重试。
      */}
      {state === "connecting" && (
        <span
          data-testid={`group-state-${group.key}`}
          className="inline-flex shrink-0 items-center text-primary"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-3 animate-spin motion-reduce:animate-none"
          />
          <span className="sr-only">
            {t("sessionIndex.machine.connecting")}
          </span>
        </span>
      )}
      {state === "unreachable" && (
        <span
          data-testid={`group-state-${group.key}`}
          className="shrink-0 rounded-sm bg-status-waiting-bg px-1 py-0.5 text-3xs font-normal text-status-waiting-text"
        >
          {t("sessionIndex.machine.unreachable")}
        </span>
      )}
      {/* 机器认得出来但不在：如实标出来，与「连机器都认不出来」是两回事。
          保持中性灰——它是事实，不是故障。带上最后在线：一台三小时前还在的
          机器和一台上周就没影的机器，值得的等待完全不同。 */}
      {group.offline && (
        <span
          data-testid={`group-offline-${group.key}`}
          className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-3xs font-normal text-muted-foreground"
        >
          {note?.lastSeenAt
            ? t("sessionIndex.machine.offlineSince", {
                time: formatRelativeTime(note.lastSeenAt, i18n.language),
              })
            : t("sessionIndex.machine.offline")}
        </span>
      )}
    </>
  );

  /**
   * 折叠按钮**之外**的那些。`<button>` 不能嵌 `<button>`，而且点重试 / ⋮ 都不该顺手
   * 把这一组折起来——包里的外壳把这一格摆在按钮外正是为了这个。
   */
  const actions = (
    <>
      {/* 只有「连不上」给重试：一台一台地试，不牵动别的机器——它们本来就是
          并行去问的。 */}
      {onRetry && state === "unreachable" && (
        <button
          type="button"
          data-testid={`group-retry-${group.key}`}
          className="shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-3xs font-medium text-primary-text hover:bg-accent"
          onClick={onRetry}
        >
          {t("sessionIndex.loadMore.retry")}
        </button>
      )}
      {/* 已经答上来的机器摆这一组有几条（含 0）。「这台机器上还没有对话」与
          「还没答上来」此前在屏幕上都是「一个组头，下面空的」（决策 10）。 */}
      {count !== undefined && (
        <span
          data-testid={`group-count-${group.key}`}
          className="shrink-0 font-mono text-3xs font-normal tabular-nums text-decorative-foreground"
        >
          {count}
        </span>
      )}
      {handlers ? <ProjectHeaderActions {...handlers} /> : null}
      {!handlers && onImport ? (
        <ImportLocalSessionMenu
          label={group.label}
          testId={`import-menu-${group.key}`}
          onImport={() => onImport(importPrefillOf(group))}
        />
      ) : null}
    </>
  );

  /**
   * 四种组头共用的那几样。**attention 记号本站不摆**：这一列上头已经有筛选 chips
   * 在说「等你处理有几条」，组头再报一遍是复述。
   */
  const common = {
    testId: "group-header",
    className: "mb-1",
    expanded: expanded ?? true,
    onToggle: toggle ?? (() => {}),
    attentionCount: 0,
    attentionTone: null,
    badges,
  } as const;

  const header =
    group.kind === "project" ? (
      <ProjectGroupHeader
        {...common}
        actions={actions}
        project={{ name: group.label, color: group.color }}
        depth={group.depth}
        // 层级在本站是**平铺一列**，所以除了包给的那条尺码阶梯还要缩进；桌面端把
        // 子项目嵌在父组的容器里，那边因此不需要这一行。
        style={{ marginLeft: group.depth * 12 }}
      />
    ) : group.kind === "machine" ? (
      <MachineGroupHeader
        {...common}
        actions={actions}
        machine={{ name: group.label, online: !group.offline }}
      />
    ) : group.kind === "unassignedProject" ? (
      // 「随手对话」是一个正当的去处，不是分类失败的残留——所以它的字形是「对话」
      // 而不是拿组名首字顶上的项目方块。发起收在页面自己的发起区里，组头上不再挂
      // 第二枚 ＋（见包里 onNewSession 的说明）；「导入本地会话…」那一条照摆——
      // 这一维本来就不预填，随手对话正是它最自然的落点。
      <FreeGroupHeader {...common} actions={actions} />
    ) : (
      <AgentGroupHeader
        {...common}
        actions={actions}
        // 没有 Agent 标识的老会话那一组：头像不编身份，组名由本站给一句兜底文案。
        agent={{
          name: group.kind === "unnamedAgent" ? "" : group.label,
          color: group.color,
        }}
        label={group.label}
      />
    );

  if (!handlers) return header;
  // 右键与 ⋮ 给出同一份菜单：菜单项只定义一次，两种容器各渲染一遍。
  return (
    <ProjectHeaderContextMenu {...handlers}>{header}</ProjectHeaderContextMenu>
  );
}

/**
 * 一行在共享包 attention 气泡里的展示模型。气泡里的行只用来「看见还有这么一条在
 * 等你」并点进去，因此不带右键删除与行尾动作——那些要的是完整的行上下文。
 */
function attentionModel(row: MirrorIndexGroupRow, href?: string) {
  return {
    id: row.key,
    status: toAgentStatus(row),
    title: row.title,
    attentionRank: "waiting",
    href,
  };
}

/**
 * 「查看全部 N 个会话」的触发器 + 弹层。
 *
 * 与共享包 `SessionGroup` 的 `totalSessions` 内建那一颗**同形同文案**（连
 * `sessionGroup.viewAll` 这条文案都取包的 `agentreUi` namespace，不另写一份），
 * 只是由宿主画，因此位置由宿主定——摆在这一组的行**之后**。为什么不能用包的那颗，
 * 见渲染处的说明。
 *
 * 收起来时触发器 `disabled`：包收起时把内容留在 DOM 里、只标 `aria-hidden`，
 * 不禁用的话 Tab 会走进一片看不见的区域。
 */
function GroupOverflowTrigger({
  total,
  scope,
  label,
  expanded,
  loadGroupPage,
  renderRow,
}: {
  total: number;
  scope: string;
  label: string;
  expanded: boolean;
  loadGroupPage: (
    scope: string,
    cursor: string | null,
  ) => Promise<{
    rows: MirrorIndexRow[];
    cursor: string | null;
    hasMore: boolean;
  }>;
  renderRow: (row: MirrorIndexGroupRow) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={!expanded}
          className="flex cursor-pointer items-center gap-1 px-2 py-1.5 text-left text-2xs font-medium text-primary-text outline-none transition-colors hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default"
        >
          {t("sessionGroup.viewAll", { count: total, ns: "agentreUi" })}
          <ArrowRight className="size-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <GroupOverflow
        scope={scope}
        label={label}
        loadGroupPage={loadGroupPage}
        renderRow={renderRow}
      />
    </Popover>
  );
}

/**
 * 「查看全部 N 个会话」弹层：按这一组的 scope 从头翻到尾。
 *
 * 行用的是索引同一个渲染器（宿主传进来的 renderRow），所以两处只有一种行。取数在
 * 宿主——它才知道当前的搜索与筛选，弹层不该自己再拼一次判据。
 */
function GroupOverflow({
  scope,
  label,
  loadGroupPage,
  renderRow,
}: {
  scope: string;
  label: string;
  loadGroupPage: (
    scope: string,
    cursor: string | null,
  ) => Promise<{
    rows: MirrorIndexRow[];
    cursor: string | null;
    hasMore: boolean;
  }>;
  renderRow: (row: MirrorIndexGroupRow) => React.ReactNode;
}) {
  return (
    <PopoverContent
      align="start"
      className="max-h-[60vh] w-[360px] overflow-y-auto p-2"
      aria-label={label}
    >
      {/* 取数放在 PopoverContent **之内**：Radix 在关着的时候不渲染它的孩子，
          因此这一组的行只在真的打开时才去翻。放在外面的话每个有溢出入口的组
          都会在首屏各发一次请求，而用户一个都没点开。 */}
      <GroupOverflowBody
        scope={scope}
        loadGroupPage={loadGroupPage}
        renderRow={renderRow}
      />
    </PopoverContent>
  );
}

function GroupOverflowBody({
  scope,
  loadGroupPage,
  renderRow,
}: {
  scope: string;
  loadGroupPage: (
    scope: string,
    cursor: string | null,
  ) => Promise<{
    rows: MirrorIndexRow[];
    cursor: string | null;
    hasMore: boolean;
  }>;
  renderRow: (row: MirrorIndexGroupRow) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MirrorIndexRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // 一挂上就在取第一页，因此初值就是「取着呢」——effect 里再同步置一次 state 会多
  // 触发一轮渲染。
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // 弹层每次打开都从头翻：中间这一组可能已经变了，接着上次的游标翻会拼出一份
  // 半新半旧的列表。
  useAliveEffect(
    (alive) => {
      loadGroupPage(scope, null)
        .then((page) => {
          if (!alive()) return;
          setRows(page.rows);
          setCursor(page.cursor);
          setHasMore(page.hasMore);
        })
        .catch(() => alive() && setFailed(true))
        .finally(() => alive() && setLoading(false));
    },
    [loadGroupPage, scope],
  );

  /** 接着往下翻。失败时已经翻出来的那些留在原地，只把失败说出来。 */
  const loadNext = useCallback(() => {
    setLoading(true);
    setFailed(false);
    loadGroupPage(scope, cursor)
      .then((page) => {
        setRows((prev) => [...prev, ...page.rows]);
        setCursor(page.cursor);
        setHasMore(page.hasMore);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [loadGroupPage, scope, cursor]);

  return (
    <>
      <div className="space-y-0.5">{rows.map(renderRow)}</div>
      {(hasMore || failed) && (
        <LoadMore loading={loading} failed={failed} onLoadMore={loadNext} />
      )}
      {/* 借页面级空态那句「没有匹配这次搜索的对话」是错的：弹层未必开在搜索里。
          这一句归它自己。 */}
      {!loading && !failed && rows.length === 0 && (
        <p
          data-testid="group-overflow-empty"
          className="px-2 py-3 text-xs text-muted-foreground"
        >
          {t("sessionIndex.group.overflowEmpty")}
        </p>
      )}
    </>
  );
}

/**
 * 一台在线机器此刻的连接档位。`connected` 说的是**它已经交出清单**，不只是中继
 * 连上了——中间那一段（连上了、清单还在路上）与还没连上对读者是同一件事：这一组
 * 现在答不出。
 */
export type MachineConnectionState = "connecting" | "connected" | "unreachable";

export interface SessionIndexProps {
  axis: IndexAxis;
  onAxisChange: (axis: IndexAxis) => void;
  rows: MirrorIndexRow[];
  projects: ProjectNode[];
  agents: AgentInfo[];
  machines: MachineInfo[];
  /**
   * 机器轴上每台**在线**机器此刻的连接档位（设备标识 → 档位）。索引只拿它判断
   * 一件事：这台机器到底有没有交出清单——没交出的时候「这台机器上还没有对话」
   * 是编的（也许它上面有一堆，只是还没连上）。离线的机器不在其中，它的状态由
   * `machines` 上的 `online` 说。
   */
  machineStates?: Record<number, MachineConnectionState>;
  /**
   * 机器轴组头的最后在线时间，按**设备标识**。
   *
   * 不塞进 `MachineInfo`：那个类型住在共享包里（`dist/session-index/axis-groups`），
   * 只有 deviceId / name / online 三列，加一列要走「先 push 再 pin SHA」那一整圈。
   */
  machineNotes?: Record<number, { lastSeenAt?: number }>;
  /**
   * 重新问一次这台机器。只有 `unreachable` 用得上：三档里只有它能靠用户动作改变
   * （`connecting` 自己会走完，`离线` 等的是那台机器而不是这一次请求）。
   */
  onRetryMachine?: (deviceId: number) => void;
  sessionPath: (deviceId: number, conversationId: string) => string;
  /**
   * 保存一条还没进账号的对话（决策 11）。不传即不摆保存动作；已经在账号里的行
   * 无论传不传都不摆——那一列不会变的图标是纯噪声。
   */
  onSave?: (row: MirrorIndexRow) => void;
  /**
   * 删除一条已保存的对话（决策 6）。不传即行上没有右键菜单。**确认由宿主给**：
   * 文案要按执行机在线与否、是不是桌面端分不同的说法，那些只有宿主知道。
   */
  onDelete?: (row: MirrorIndexRow) => void;
  /**
   * 行尾是否摆本地化的状态文字徽标。移动端开（规格「已知的可见变化」3：共享
   * `StatusDot` 的可访问名只剩英文状态码，行上得有一处看得见的本地化状态）；
   * 桌面端不开——那一端由状态点承担，多一枚徽标只是把 320px 的行挤窄。
   */
  rowStatusLabel?: boolean;
  /**
   * 宿主是不是已经按搜索收窄过 rows。收窄到一条不剩时空态说的是「这次搜索没有
   * 匹配」，而不是「你还没有对话」——那些会话还在，只是这次搜索不收。
   */
  narrowed?: boolean;
  /**
   * 筛选 chip 由**宿主**持有（规格 2026-08-19 决策 9）：筛选现在在服务端的完整
   * 集合上做，留在这一层就只筛得到已加载的那些，「等你处理」会漏掉真在等的对话。
   */
  filter: SessionFilter;
  onFilterChange: (filter: SessionFilter) => void;
  /** 「等你处理」chip 上那个数，同样来自服务端的完整集合。 */
  unreadCount?: number;
  /**
   * 组键 → 这一组在当前范围下的真数（规格 2026-08-19 决策 6）。「查看全部 N」那个
   * N 就是它——服务端才数得出，这一层手里只有已加载的那几条。
   */
  groupTotals?: Record<string, number>;
  /**
   * 翻某一组的下一页（「查看全部 N」里那条路）。给 scope 与游标，回一页行。
   * 取数在宿主（它才知道当前的搜索与筛选），行怎么画仍在这一层——两端只有一种行。
   */
  loadGroupPage?: (
    scope: string,
    cursor: string | null,
  ) => Promise<{
    rows: MirrorIndexRow[];
    cursor: string | null;
    hasMore: boolean;
  }>;
  /** 还有下一页时摆「加载更多」。分页的位置与取数都在宿主手里。 */
  hasMore?: boolean;
  loadingMore?: boolean;
  /** 上一次取下一页失败：就地给可重试的提示，不静默停住（决策 16）。 */
  loadMoreFailed?: boolean;
  /**
   * 账号里一共有多少条（不受当前筛选 / 搜索影响）。空态用它说出「东西还在，
   * 只是这一档不收」——一个数比一句「没有符合这个筛选的对话」有用得多。
   */
  accountTotal?: number;
  /** 清掉搜索词。搜索框在宿主那边，索引自己清不了（决策 12）。 */
  onClearSearch?: () => void;
  onLoadMore?: () => void;
  /** 桌面右栏选中的那条会话（点行不导航，右栏就地嵌详情）。 */
  selectedKey?: string | null;
  /**
   * 点开一行。交出去的是**整行**：宿主要用行上的发起端指纹去镜像里取转录（机器
   * 离线时那是唯一的来源），与保存 / 删除同一条口径。
   */
  onSelect?: (row: MirrorIndexRow) => void;
  /**
   * 项目组头上那三样动作（规格 2026-08-20）。宿主给才有——索引自己既不知道账号里有
   * 哪些 Agent，也不该替调用方决定「点了之后去哪」；不给就是今天这个样子：组头上
   * 只有字形与名字。
   */
  projectHandlers?: (projectSyncId: string) => ProjectHeaderActionsProps | null;
  /**
   * 建一个**顶层**项目的去处（规格 2026-08-21-root-project-entry 决策 1）。
   * 与 `projectHandlers` 同一条口径：宿主给才有，索引不替它决定点了之后去哪。
   * 只在项目轴上渲染——别的轴没有项目这一维，摆了就是问一个它答不出的问题。
   */
  onNewProject?: () => void;
}

export default function SessionIndex({
  axis,
  onAxisChange,
  rows,
  projects,
  agents,
  machines,
  machineStates,
  machineNotes,
  onRetryMachine,
  sessionPath,
  onSave,
  onDelete,
  rowStatusLabel = false,
  narrowed = false,
  filter,
  onFilterChange,
  unreadCount = 0,
  groupTotals,
  loadGroupPage,
  hasMore = false,
  loadingMore = false,
  loadMoreFailed = false,
  accountTotal,
  onClearSearch,
  onLoadMore,
  selectedKey = null,
  onSelect,
  projectHandlers,
  onNewProject,
}: SessionIndexProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  /** 键盘光标停在哪一行。与宿主的选中分开：移光标不等于开右栏。 */
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  /** 当前收起的那些组（组键 → 收着没有）。由组头回报，见 GroupHeader。 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const onGroupExpandedChange = useCallback(
    (key: string, expanded: boolean) => {
      setCollapsed((prev) =>
        !!prev[key] === !expanded ? prev : { ...prev, [key]: !expanded },
      );
    },
    [],
  );

  /**
   * 「导入本地会话」（规格 2026-08-26 的远端一半）。
   *
   * 这件事整条都是包的：对话框、候选列表、转录预览、组头上那条菜单项。本站只提供
   * ports —— 而 ports 里的机器名单就是索引手里这一份（组头问的是同一批机器）。
   *
   * `prefill` 不为 null 即对话框开着：预填与开关是同一件事的两面，拆成两个状态就有
   * 「开着但预填是上一次那一维」的中间态。
   */
  const [importPrefill, setImportPrefill] =
    useState<ImportDialogPrefill | null>(null);
  /**
   * 续跑目标的名单。索引手里那份 `agents` 只有身份与颜色（共享包的 `AgentInfo`），
   * 没有后端类型，而包正是按后端过滤「接得住这条会话的 Agent」——所以对话框第一次
   * 打开时另取一次。**开之前不取**：索引常驻渲染，为一个还没打开的对话框发请求是白发。
   */
  const [importAgents, setImportAgents] = useState<NewConvAgent[]>([]);
  useEffect(() => {
    if (importPrefill === null || importAgents.length > 0) return;
    let alive = true;
    void api<{ agents?: NewConvAgent[] }>("/v1/workspace/agents")
      .then((res) => {
        if (alive) setImportAgents(res.agents ?? []);
      })
      // 取不到就只是没得选「接着跑」——导入本身照做，不该被这一次取数连坐。
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [importPrefill, importAgents.length]);

  const importPorts = useMemo(
    () =>
      createBrowserSessionImportPorts({
        devices: machines.map((m) => ({
          id: m.deviceId,
          name: m.name,
          online: m.online,
        })),
        agents: importAgents,
        openSession: (deviceId, conversationId) =>
          navigate(sessionPath(deviceId, conversationId)),
      }),
    [machines, importAgents, navigate, sessionPath],
  );

  /**
   * 导完（含「早就导过」那一支）之后：关掉对话框，跳到那条会话。
   *
   * 跳过去而不是只刷新列表——用户点「导入」要的是这条对话，而它此刻在索引里可能
   * 还没出现：会话是机器建的，本站这一份要等镜像流把它带上来。
   */
  const onImported = useCallback(
    (outcome: ImportOutcome) => {
      setImportPrefill(null);
      importPorts.openSession(outcome.sessionId);
    },
    [importPorts],
  );

  const groups = useMemo(() => {
    const built = buildAxisGroups(axis, {
      // 筛选已经在服务端做过了（决策 9），这里不再筛一遍：筛两次的话服务端给的
      // 那一页会被本地判据再削一刀，用户看到的条数与组头上的数对不上。
      rows,
      totals: groupTotals,
      projects,
      agents,
      machines,
      labels: {
        unassignedProject: t("sessionIndex.group.unassignedProject"),
        unnamedAgent: t("sessionIndex.group.unnamedAgent"),
        unknownMachine: t("chat.noMachine"),
      },
    });
    // 共享包用 `...row` 原样摊行，宿主那两维（conversationId / lastReadAt）因此
    // 照样在，只是包的类型说不出来。见 chatRows 的 MirrorIndexGroupRow。
    const groups = built as MirrorIndexGroup[];
    return axis === "machine" ? withEveryMachine(groups, machines) : groups;
  }, [axis, rows, groupTotals, projects, agents, machines, t]);

  const hasRows = groups.some((g) => g.rows.length > 0);

  /**
   * ↑↓ 走得到的行，按渲染顺序。两类行不在其中：
   *
   *  - 认不出机器的行——详情页的地址是 `/devices/:deviceId/...`，没有机器就没有
   *    可去的地方，光标停在那里会卡住；
   *  - **收起的组里的行**（规格 2026-08-19「组怎么收怎么放」可达性）——共享包收起
   *    时把内容留在 DOM 里、只标 `aria-hidden`，因此不排掉的话 ↓ 会把真焦点送进一
   *    片看不见的区域：屏幕上光标凭空消失，读屏也念不出当前这条。
   */
  const navRows = useMemo(
    () =>
      groups
        .filter((g) => !collapsed[g.key])
        .flatMap((g) => g.rows)
        .filter((r) => r.deviceId !== undefined),
    [groups, collapsed],
  );
  /**
   * ↑↓ 从哪一行接着走；宿主选中的那一条是它的初值（点了一行再按 ↑ 就从那一条
   * 往上走）。
   *
   * **只管键盘**：行上那一层高亮说的是「右栏此刻开着哪一条」，那件事只有宿主
   * 知道（`selectedKey`）。两者曾是同一个值，于是点过一行之后光标就把高亮钉死
   * 在那一行上——宿主后来把右栏换成别的（刚开出来的新对话、删掉当前这条之后
   * 收起右栏），左栏还标着上一条。
   */
  const activeKey = cursorKey ?? selectedKey;

  const openRow = useCallback(
    (row: MirrorIndexGroupRow) => {
      const deviceId = row.deviceId;
      if (deviceId === undefined) return;
      if (onSelect) onSelect(row);
      else navigate(sessionPath(deviceId, row.conversationId));
    },
    [onSelect, navigate, sessionPath],
  );

  /**
   * 索引里的一行。抽出来是因为它有**两个**渲染处：组里先列的那几条，以及「查看
   * 全部 N」弹层里翻出来的那些。两处各写一遍就会长成两种行。
   */
  const renderRow = useCallback(
    (row: MirrorIndexGroupRow) => (
      <RowContextMenu
        key={row.key}
        // 删除只对已保存的行成立：没保存过的对话账号里没有它。
        onDelete={
          onDelete && row.saved !== false ? () => onDelete(row) : undefined
        }
      >
        <SessionRow
          status={toAgentStatus(row)}
          title={row.title}
          // 移动端的本地化状态兜底（规格「已知的可见变化」3）。
          trailingLabel={
            rowStatusLabel ? sessionStatusLabel(row, t) : undefined
          }
          selected={selectedKey === row.key}
          href={
            row.deviceId === undefined
              ? undefined
              : sessionPath(row.deviceId, row.conversationId)
          }
          renderLink={({ href, children, ...rest }) => (
            <Link to={href} data-nav-target={row.key} {...rest}>
              {children}
            </Link>
          )}
          onClick={
            onSelect
              ? (e) => {
                  e.preventDefault();
                  // 点行 = 把键盘光标也挪过来：↑↓ 接着从这一条走。
                  setCursorKey(row.key);
                  openRow(row);
                }
              : undefined
          }
          leading={
            <RowLeadingSlot
              axis={axis}
              agent={row.agent}
              project={row.project}
            />
          }
          secondaryLabel={
            <RowSecondaryLine
              axis={axis}
              agent={row.agent}
              project={row.project}
              machine={row.machine}
              // 项目那一维缺席时如实写「随手对话」并把字形置灰（决策 7）：
              // 与它在项目轴上的兜底组头同一句文案，也与桌面端同源。
              freeLabel={t("sessionIndex.group.unassignedProject")}
              testId={`row-secondary-${row.key}`}
            />
          }
          trailing={<LastActive ms={row.updatedAt} locale={i18n.language} />}
          rowActions={
            onSave && row.saved === false ? (
              <SaveButton
                testId={`row-save-${row.key}`}
                onSave={() => onSave(row)}
              />
            ) : undefined
          }
        />
      </RowContextMenu>
    ),
    [
      axis,
      selectedKey,
      i18n.language,
      onDelete,
      onSave,
      onSelect,
      openRow,
      rowStatusLabel,
      sessionPath,
      t,
    ],
  );

  /**
   * ↑↓ 移动的是**真焦点**（落在行链接上），不是一个只有颜色的高亮：长列表因此由
   * 浏览器自己滚进视口，读屏也跟着念出当前这条。Enter 打开光标所在的那一行。
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") {
        return;
      }
      // 从行以外的可交互元素（筛选 chips / 两个选择器 / 行尾「保存」）冒上来的
      // 按键不接管：那里的 Enter 是它们自己的动作，抢过来就把它按成了开会话。
      const from = e.target;
      if (
        from !== e.currentTarget &&
        !(from instanceof Element && from.closest("[data-nav-target]"))
      ) {
        return;
      }
      const at = navRows.findIndex((r) => r.key === activeKey);
      if (e.key === "Enter") {
        if (at === -1) return;
        e.preventDefault();
        openRow(navRows[at]);
        return;
      }
      if (navRows.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      // 没有光标时：↓ 从第一条开始，↑ 从最后一条开始。到头不回绕。
      const base = at === -1 ? (dir === 1 ? -1 : navRows.length) : at;
      const next = Math.min(navRows.length - 1, Math.max(0, base + dir));
      const target = navRows[next];
      setCursorKey(target.key);
      containerRef.current
        ?.querySelector<HTMLElement>(`[data-nav-target="${target.key}"]`)
        ?.focus();
    },
    [navRows, activeKey, openRow],
  );

  return (
    <div
      ref={containerRef}
      data-testid="session-index-nav"
      onKeyDown={onKeyDown}
      className="space-y-3"
    >
      {/*
        选择器与筛选 chips 同一行：320px 栏减掉内边距还有 300px，轴选择器加三个
        chip 量下来 258px 放得下；只有机器轴多一个机器选择器（334px）才装不下，
        那一档 chips 整块折到第二行——多出来的那一行是因为它真的多一个控件，
        另外三个轴不必陪着空一行。
      */}
      <div
        data-testid="index-controls"
        className="flex flex-wrap items-center gap-1.5"
      >
        {/* 可选轴清单由宿主给（共享包决策 17）：本站四档全给，桌面端只 offer 三档。 */}
        <AxisPicker value={axis} axes={INDEX_AXES} onChange={onAxisChange} />
        {/* 筛完一条不剩时 chips 仍在：否则回不到「全部」，索引看着就像坏了。 */}
        <FilterChips
          filter={filter}
          unreadCount={unreadCount}
          onFilterChange={onFilterChange}
        />
        {/*
          建顶层项目的入口（规格 2026-08-21-root-project-entry 决策 1）。摆在控件行
          而不是组头上，正因为它要在「一个组头都没有」时也在——账号里一个项目都
          没有的人，恰恰是最需要它的那个。

          字形不是 Plus：左栏 52px 头里那颗「新对话」已经是 Plus（Chat.tsx），两颗
          上下相邻，同一枚字形指两件不同的事就是把「点错」写进设计（决策 2）。

          ml-auto 顶到行尾；chips 是 shrink-0，因此挤不动它们，装不下时整行照旧
          按 flex-wrap 折行。
        */}
        {axis === "project" && onNewProject ? (
          <button
            type="button"
            data-testid="index-new-project"
            aria-label={t("project.create.title")}
            title={t("project.create.title")}
            onClick={onNewProject}
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FolderPlus className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {/* 机器轴上一条行都没有不等于「你还没有对话」：那一轴的每个空组自己会说
          「这台机器上还没有对话」，页面级再说一遍就是同一句话说两遍。收窄之后
          才需要这一句——「没有匹配这次搜索」是组头说不出的。
          但「组头自己会说」得真有组头才成立：一台能跑会话的机器都没有时这一轴
          连一个组都出不来，不说话就是一块无言的空白。 */}
      {!hasRows && (axis !== "machine" || narrowed || groups.length === 0) ? (
        <IndexEmpty
          filter={filter}
          narrowed={narrowed}
          accountTotal={accountTotal}
          onFilterChange={onFilterChange}
          onClearSearch={onClearSearch}
        />
      ) : null}
      {/* 机器轴的组头本身就是答案的一部分（哪台机器在、它此刻什么状态），
          因此一行都没有时组照样列。项目轴同理，而且更硬：组头是「机器与路径…」
          「成员…」「未配置」角标唯一的挂点（规格 2026-08-20 决策 1 / 9），
          组头不在，刚建出来的项目就再也配不了路径——而没配路径的项目开不出
          对话，于是它永远长不出行、永远回不来（规格 2026-08-21-root-project-entry
          决策 6）。这两轴的「有哪些组」都不是从会话推出来的，是宿主直接给的名单。 */}
      {hasRows || axis === "machine" || axis === "project"
        ? groups.map((group) => {
            const scope = scopeOfGroup(group);
            const overflow =
              scope &&
              loadGroupPage &&
              group.total !== undefined &&
              group.total > group.rows.length
                ? group.total
                : undefined;
            /*
            空组要不要说一句（规格 2026-08-21「机器轴列什么」）：

            - 在线、清单为空 → 「这台机器上还没有对话」。孤零零一个组头读起来像坏了。
            - 离线 → 什么也不说：原因已经在组头上，这一组答不出「有什么」。
            - 收窄过 → 什么也不说：「还没有对话」在这里是假话，它们还在，只是这次
              搜索/筛选不收；页面级那一句负责说这件事。
            - 还没交出清单（连接中 / 连不上）→ 什么也不说：这一组现在答不出，
              「还没有对话」会是编的。
          */
            const machineDeviceId = Number(group.key.replace(/^device-/, ""));
            const machineState = machineStates?.[machineDeviceId];
            const answered =
              machineStates === undefined || machineState === "connected";
            const emptyNote =
              group.kind === "machine" &&
              group.rows.length === 0 &&
              !group.offline &&
              !narrowed &&
              answered ? (
                <p className="px-1 py-0.5 text-xs text-muted-foreground">
                  {t("sessionIndex.machine.empty")}
                </p>
              ) : null;
            /*
              还没答上来的那一组（连接中）：摆骨架，不是一个孤零零的空组头
              （规格 2026-08-21-connection-failure-ux 决策 9）。它既说明「在动」，
              又把行的位置先占住，清单回来时这一组不会把下面几组顶开。
            */
            const pending =
              group.kind === "machine" &&
              group.rows.length === 0 &&
              machineState === "connecting";
            const rowsBody = (
              <div className="space-y-0.5">
                {group.rows.map(renderRow)}
                {pending ? (
                  <div data-testid="group-skeleton">
                    <SessionListSkeleton rows={2} />
                  </div>
                ) : (
                  emptyNote
                )}
              </div>
            );
            // 时间轴那一组没有组头，也就没有可收放的东西：它是单一平铺列表，
            // 继续往下翻由列表末尾的「加载更多」承担。
            if (group.kind === "all") {
              return (
                <section key={group.key} data-testid={`group-${group.key}`}>
                  {rowsBody}
                </section>
              );
            }
            /*
            「查看全部 N」由**宿主**画在行之后，不再走共享包的 `totalSessions`。
            包的渲染次序是 `sessions` → 触发器 → `renderAfterSessions`，而本站的行
            全部走 `renderAfterSessions`（它们带着右键菜单与行尾「保存」，塞不进包的
            `SessionRowModel`）——于是触发器落在了这一组所有行的**前面**，读起来像
            组的开头而不是它的末尾。桌面端不撞这个：它的行走 `sessions`，
            `renderAfterSessions` 里装的是子项目子树，次序天然是对的。

            更干净的落法是把行也搬进 `sessions`，但包在 `onDeleteSession` 上
            `Number(session.id)`，而本站的行键是 `<指纹>:<会话号>` 这种字符串
            （同号会话可能来自两台机器），搬过去删除就会拿到 NaN。那是一处跨仓改动。
          */
            const body = (
              <>
                {rowsBody}
                {overflow && scope && loadGroupPage ? (
                  <GroupOverflowTrigger
                    total={overflow}
                    scope={scope}
                    label={group.label}
                    expanded={!collapsed[group.key]}
                    loadGroupPage={loadGroupPage}
                    renderRow={renderRow}
                  />
                ) : null}
              </>
            );
            return (
              <SessionGroup
                key={group.key}
                data-testid={`group-${group.key}`}
                aria-busy={pending || undefined}
                aria-label={group.label || undefined}
                // 收放状态按「轴 + 组」记在本地：换个轴看的是另一套组，两套不该互相
                // 覆盖。共享包自己会加 agentre.agentExpanded. 前缀。
                persistenceKey={`server.index.${axis}.${group.key}`}
                defaultExpanded
                renderHeader={({ expanded, toggle }) => (
                  <GroupHeader
                    group={group}
                    state={machineState}
                    note={machineNotes?.[machineDeviceId]}
                    // 计数只给**已经答上来**的机器：没答上来时「这一组有几条」
                    // 这件事本身不成立，摆一个 0 是在编。
                    count={
                      group.kind === "machine" && machineState === "connected"
                        ? (group.total ?? group.rows.length)
                        : undefined
                    }
                    onRetry={
                      onRetryMachine
                        ? () => onRetryMachine(machineDeviceId)
                        : undefined
                    }
                    expanded={expanded}
                    toggle={toggle}
                    onExpandedChange={onGroupExpandedChange}
                    projectHandlers={projectHandlers}
                    onImport={setImportPrefill}
                  />
                )}
                // 收起来时组头上仍露出这一组里在等你处理的那些：收起的是列表，
                // 不是提醒。展开时气泡为空——那几条已经在下面的列表里了，再冒一遍
                // 就是同一条会话在同一个组里出现两次。
                attentionSessions={[]}
                collapsedAttentionSessions={group.rows
                  .filter((r) => r.waitingForInput)
                  .map((r) =>
                    attentionModel(
                      r,
                      r.deviceId === undefined
                        ? undefined
                        : sessionPath(r.deviceId, r.conversationId),
                    ),
                  )}
                renderLink={({ href, children, ...rest }) => (
                  <Link to={href} {...rest}>
                    {children}
                  </Link>
                )}
                onSessionSelect={(id) => {
                  const row = group.rows.find((r) => r.key === id);
                  if (row) {
                    setCursorKey(row.key);
                    openRow(row);
                  }
                }}
                renderAfterSessions={body}
              />
            );
          })
        : null}
      {(hasMore || loadMoreFailed) && onLoadMore && (
        <LoadMore
          loading={loadingMore}
          failed={loadMoreFailed}
          onLoadMore={onLoadMore}
        />
      )}
      {/*
        导入对话框整条都在包里，本站只给 ports 与「导完去哪」。**条件渲染**而不是
        常驻 open={false}：里面那份候选列表一挂载就去问机器，常驻等于每次进会话页
        都朝每台机器发一次扫描。
      */}
      {importPrefill !== null && (
        <ImportSessionDialog
          open
          onOpenChange={(open) => {
            if (!open) setImportPrefill(null);
          }}
          ports={importPorts}
          prefill={importPrefill}
          onImported={onImported}
        />
      )}
    </div>
  );
}

/**
 * 列表末尾的「加载更多」（规格 2026-08-19 决策 16）。
 *
 * 它是一个**真按钮**而不是只有一个滚动哨兵：滚到底自动取下一页由 IntersectionObserver
 * 触发，但键盘与读屏用户也得够得着同一个动作，而且取失败之后必须有一个能重按的东西。
 * 失败时按钮换成「重试」并把失败说出来——静默停住会被读成「到底了」。
 */
function LoadMore({
  loading,
  failed,
  onLoadMore,
}: {
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 失败之后不再自动重试：同一个错误会被一路滚到底反复触发。要再来一次由用户按。
    if (failed || loading || typeof IntersectionObserver !== "function") return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [failed, loading, onLoadMore]);

  const trigger = (
    <button
      ref={ref}
      type="button"
      data-testid="index-load-more"
      disabled={loading}
      onClick={onLoadMore}
      className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-60"
    >
      {t(
        loading
          ? "sessionIndex.loadMore.loading"
          : failed
            ? "sessionIndex.loadMore.retry"
            : "sessionIndex.loadMore.label",
      )}
    </button>
  );

  /*
    失败时改成一条内联的失败条：图标 + 一句 + 重试在同一行（决策 12）。此前是
    居中的一行 11px 小红字加一个居中按钮，读起来像列表自己的一部分。

    红色换成 destructive 家族（决策 13）：此前这里用 `status-error`，而横幅那边
    用 `destructive`——同一个「出错了」两个 token。`status-error` 此后只表达
    **会话自身**的状态（interrupted 的那颗点），不再兼职表达「这次操作失败了」。
  */
  if (failed) {
    return (
      <div
        role="alert"
        data-testid="index-load-more-failed"
        className="mt-1.5 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive-soft px-2.5 py-2 text-xs text-destructive-text"
      >
        <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {t("sessionIndex.loadMore.failed")}
        </span>
        {trigger}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1.5 py-3">{trigger}</div>
  );
}

/**
 * 三种空态，各带一条回程（决策 12），形取共享的 `InlineEmpty`。
 *
 * 此前三种共用一行 14px 灰字，靠左，没有任何出路：chips 还在，但没人说该按哪个。
 * 而它们说的不是一回事——筛空了要回「全部」，搜空了要清搜索词，真空要开第一条。
 *
 * 后来补上了出路，但那句话还是含糊的：「这一档里一条都没有」——「档」是这份代码
 * 里的说法，读者眼前只有 chip 上的「运行中」「等你处理」。标题现在**逐字回指**
 * 那个 chip，正文才说账号里还有多少条：读者据此立刻知道东西还在。
 *
 * `accountTotal` 是可选的，undefined ≠ 0：宿主没算出来只是少说一句正文，不该把
 * 回「全部」的路也一起吞掉（此前 `?? 0` 把两者揉成一个，筛进空档就出不来了）。
 * 真的一条都没有时才不摆按钮——那条路通向的是另一块空白。
 *
 * 接不住那个动作（宿主没给回调）就不摆按钮：一个按下去什么都不发生的按钮比没有
 * 按钮更坏。
 */
function IndexEmpty({
  filter,
  narrowed,
  accountTotal,
  onFilterChange,
  onClearSearch,
}: {
  filter: SessionFilter;
  narrowed: boolean;
  accountTotal?: number;
  onFilterChange: (filter: SessionFilter) => void;
  onClearSearch?: () => void;
}) {
  const { t } = useTranslation();
  const filtered = filter !== "all";
  // 账号里确实一条都没有（0）与「宿主没算」（undefined）是两回事。
  const emptyAccount = accountTotal === 0;

  let icon = MessagesSquare;
  let title = t("chat.noSessions");
  let body: string | undefined;
  let action: { label: string; run: () => void } | undefined;

  if (filtered) {
    icon = ListX;
    title = t("sessionIndex.filter.emptyTitle", {
      label: t(`sessionIndex.filter.${filter}`),
    });
    if (accountTotal !== undefined && accountTotal > 0) {
      body = t("sessionIndex.filter.emptyBodyWithTotal", {
        count: accountTotal,
      });
      action = {
        label: t("sessionIndex.filter.seeAll", { count: accountTotal }),
        run: () => onFilterChange("all"),
      };
    } else if (!emptyAccount) {
      body = t("sessionIndex.filter.emptyBody");
      action = {
        label: t("sessionIndex.filter.seeAllPlain"),
        run: () => onFilterChange("all"),
      };
    }
  } else if (narrowed) {
    icon = SearchX;
    title = t("sessionIndex.search.emptyTitle");
    body = t("sessionIndex.search.emptyBody");
    if (onClearSearch)
      action = { label: t("sessionIndex.search.clear"), run: onClearSearch };
  }

  return (
    <InlineEmpty
      testId="session-index-empty"
      icon={icon}
      title={title}
      body={body}
      action={
        action && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-2xs"
            data-testid="empty-action"
            onClick={action.run}
          >
            {action.label}
          </Button>
        )
      }
    />
  );
}
