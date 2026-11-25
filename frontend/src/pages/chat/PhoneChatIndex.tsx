import {
  Button,
  SearchInput,
  SessionFilterChips,
  SessionIndexEmpty,
  SessionLifecycle,
  SessionRow,
  SessionRowSkeleton,
  StatusDot,
  cn,
  phaseSections,
  useUiTranslation,
  type AgentStatus,
  type PhaseSectionKey,
  type SessionRowLinkRenderer,
} from "@agentre-hub/agentre-ui";
import {
  ChevronDown,
  LoaderCircle,
  MessageCirclePlus,
  RotateCw,
  Search,
  SquarePen,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { flushSync } from "react-dom";
import { Link, useLocation } from "react-router-dom";

import { IdentityUnstableStrip } from "@/components/AppShell";
import { EmptyState, MobileNavButton } from "@/components/console";
import {
  IndexRefreshBar,
  LoadMore,
  SaveButton,
  type SessionIndexAgent,
  type SessionPathTarget,
} from "@/components/session/SessionIndex";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
import { toAgentStatus } from "@/lib/attentionAdapter";
import { describeFailure } from "@/lib/describeFailure";
import { conversationDraftKey, useDraftMap } from "@/lib/drafts";
import { useOutboxMap } from "@/lib/outbox";
import { useStoppingRows } from "@/pages/chat/stopRowTurn";
import type { ProjectNode } from "@/lib/projects";
import { formatRelativeTime } from "@/lib/sessionView";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import {
  isRowUnread,
  rowSubline,
  startOfToday,
  toPhaseItem,
  type PhoneCounts,
  type PhoneFilter,
} from "@/pages/chat/phoneRows";

/**
 * 手机首页的滚动位置，按「范围 + 筛选」记（规格 2026-11-05「首页」返回恢复；2026-11-25
 * D5：换筛选不能冲掉别的筛选的位置，「全部」滚到 1082 → 进行中 → 回全部要回到 1082）。
 *
 * 打开一条对话时这一屏整个让给详情（Chat 在手机上不留第二栏），列表的 DOM 随之卸掉；
 * 返回时把位置放回去。模块级而不是组件状态：卸掉的组件留不住任何东西。
 * 筛选本身是 Chat 的状态，Chat 在 `/chat` 与 `/chat/:id` 之间不卸载。
 */
const scrollMemory = new Map<string, number>();

/**
 * 刚打开的那一行（D5）：返回列表时焦点回到它。同样要跨组件卸载，所以放模块里；
 * 回焦一次就清掉，不会在之后无关的重绘里再抢焦点。
 */
let lastOpenedRow: string | null = null;

/** 新数据替换本地数据时，离开的行淡出多久后从列表里拿掉（与 fade-out 时长一致）。 */
const LEAVE_MS = 200;

/**
 * 本地数据换成新数据的那一刻（规格 2026-11-25 决策 A5）。
 *
 * 旧样子的那批行在 `stale` 期间一直记着；`stale` 落下时与新的一批比一次：多出来的
 * 行淡入，走掉的行原地淡出、`LEAVE_MS` 之后拿掉，其余行就是原来那几个节点。
 */
interface Swap {
  stale: boolean;
  /** `stale` 期间最后一批行。 */
  staleRows: MirrorIndexRow[];
  entering: ReadonlySet<string>;
  leaving: MirrorIndexRow[];
}

const NO_ENTERING: ReadonlySet<string> = new Set();

/** 两批行是不是同一组对话（同序）。按身份比而不是按引用：宿主每次给新数组也不会来回置。 */
function sameKeys(a: MirrorIndexRow[], b: MirrorIndexRow[]): boolean {
  return a.length === b.length && a.every((row, i) => row.key === b[i].key);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 页头副标题：一句状态，前面可带一颗点。 */
export interface PhoneSubtitle {
  text: string;
  dot?: AgentStatus | null;
}

export interface PhoneChatIndexProps {
  /** 范围的身份（返回恢复按它记位置）。 */
  scopeKey: string;
  /** 范围名，页头标题。 */
  scopeTitle: string;
  subtitle: PhoneSubtitle;
  /**
   * 点标题「范围名 ⌄」：升起范围弹层。弹层由页面接（另一件任务），这里只交出去。
   */
  onOpenScope: () => void;
  /** ✎：新对话。 */
  onCompose: () => void;

  searchQuery: string;
  onSearchChange: (q: string) => void;
  /** 搜索命中几条（搜索框下那一句）。 */
  searchCount: number;

  /** 这一范围的结论到了没有。没到时摆骨架。 */
  settled: boolean;
  /**
   * 换了范围（范围 / 筛选 / 搜索）、新的还没回来，`rows` 是上一范围的旧行（弱网规格
   * 2026-11-20 决策 5）：留在原位变淡、仍点得开，列表 aria-busy，筛选条下出细进度条。
   */
  refreshing?: boolean;
  /**
   * 摆着的是本机存储里上次的样子（规格 2026-11-25 决策 A5）：行上的实时标记（等你 /
   * 运行中 / 出错）与页头的在线点置灰，直到新数据到达。
   */
  stale?: boolean;
  /**
   * 本地的旧样子正在被核对：分组标题旁「同步中」，页头副行前加「更新中」，页头底边
   * 出细进度条。取数失败、或没有网络时不说（那时没有在同步）。
   */
  syncing?: boolean;
  /** 身份核对失败（「网络不稳定」）：细条摆在这一页自己的页头下方。 */
  unstable?: boolean;
  /** 已按筛选收窄过的行。 */
  rows: MirrorIndexRow[];
  filter: PhoneFilter;
  onFilterChange: (filter: PhoneFilter) => void;
  counts: PhoneCounts;
  /** 账号里一共几条（筛选空态说「还有多少不在这一档」）。 */
  accountTotal?: number;

  agents: SessionIndexAgent[];
  projects: ProjectNode[];
  /** 这一范围就是一个 Agent：第二行不再重复 Agent 名。 */
  hideAgent: boolean;
  sessionPath: (target: SessionPathTarget) => string;

  /** 行菜单：各项返回 undefined 即这一行不摆这一项。 */
  stopTurnOf: (row: MirrorIndexRow) => (() => void) | undefined;
  filterAgentOf: (row: MirrorIndexRow) => (() => void) | undefined;
  filterMachineOf: (row: MirrorIndexRow) => (() => void) | undefined;
  onDelete: (row: MirrorIndexRow) => void;
  onSave: (row: MirrorIndexRow) => void;

  /** 一条都没有、也没在搜/筛时的出口（规格「空态」）。 */
  hasOnlineMachine: boolean;
  onFindOnMachine: () => void;
  /**
   * 设备名单**已知**且一台都没有（首次使用，J1）：主按钮换成「添加设备」。名单还没
   * 到、或取数失败时不传 / 传 false——空数组说不出是「没有设备」还是「还不知道」。
   */
  noDevice?: boolean;

  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  onLoadMore: () => void;
  /** 列表之上的横幅（取数失败、保存失败）。 */
  banners?: ReactNode;
  /**
   * 这一次取数失败了。手上一条行都没有时，空列表说明不了「没有对话」，整块换成
   * 错误态（宿主那时也不该再递取数失败的横幅）；已有行时由横幅说。
   */
  loadFailed?: boolean;
  /** 那次失败的原值：错误态的正文与出口经 describeFailure 分类（401 给「重新登录」）。 */
  loadError?: unknown;
  onRetry?: () => void;
}

/** 分段的标题（字面 key：未用 key 守卫按字面认读者）。 */
const SECTION_LABEL: Record<PhaseSectionKey, string> = {
  needsYou: "chat.phone.section.needsYou",
  inProgress: "chat.phone.section.inProgress",
  today: "chat.phone.section.today",
  earlier: "chat.phone.section.earlier",
};

/** 一个项目的路径：「父 / 子」。 */
function projectPath(
  syncId: string,
  byId: Map<string, ProjectNode>,
): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  for (
    let node = byId.get(syncId);
    node && !seen.has(node.syncId);
    node = node.parentSyncId ? byId.get(node.parentSyncId) : undefined
  ) {
    seen.add(node.syncId);
    names.unshift(node.name);
  }
  return names.length > 0 ? names.join(" / ") : null;
}

const renderLink: SessionRowLinkRenderer = ({
  sessionId,
  href,
  children,
  ...rest
}) => (
  <Link to={href} data-nav-target={sessionId} {...rest}>
    {children}
  </Link>
);

export function PhoneChatIndex({
  scopeKey,
  scopeTitle,
  subtitle,
  onOpenScope,
  onCompose,
  searchQuery,
  onSearchChange,
  searchCount,
  settled,
  refreshing = false,
  stale = false,
  syncing = false,
  unstable = false,
  rows,
  filter,
  onFilterChange,
  counts,
  accountTotal,
  agents,
  projects,
  hideAgent,
  sessionPath,
  stopTurnOf,
  filterAgentOf,
  filterMachineOf,
  onDelete,
  onSave,
  hasOnlineMachine,
  onFindOnMachine,
  noDevice = false,
  hasMore,
  loadingMore,
  loadMoreFailed,
  onLoadMore,
  banners,
  loadFailed = false,
  loadError,
  onRetry,
}: PhoneChatIndexProps) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const { t: uiT } = useUiTranslation();
  const drafts = useDraftMap();
  const outbox = useOutboxMap();
  const stoppingRows = useStoppingRows();
  // 搜索词还在（从对话返回）时，回来仍是搜索那一屏。
  const [searchOpen, setSearchOpen] = useState(() => searchQuery !== "");
  const listRef = useRef<HTMLDivElement>(null);
  const memoryKey = `${scopeKey}|${filter}`;

  // 位置在列表真的摆出来之后才放回去：骨架那一刻放回去会被内容撑开时冲掉；摆着的
  // 还是上一范围的旧行时同理，等新范围的行落地再放。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !settled || refreshing) return;
    el.scrollTop = scrollMemory.get(memoryKey) ?? 0;
    // 从详情返回：焦点回到刚打开的那一行，且不让浏览器为了聚焦再滚一次。
    if (lastOpenedRow !== null) {
      const row = Array.from(
        el.querySelectorAll<HTMLElement>("[data-nav-target]"),
      ).find((node) => node.dataset.navTarget === lastOpenedRow);
      lastOpenedRow = null;
      row?.focus({ preventScroll: true });
    }
  }, [memoryKey, settled, refreshing]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (el) scrollMemory.set(memoryKey, el.scrollTop);
  }, [memoryKey]);
  const onListClickCapture = useCallback((e: MouseEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-nav-target]",
    );
    if (row) lastOpenedRow = row.dataset.navTarget ?? null;
  }, []);

  // 旧样子换成新数据：渲染期比一次，不经 effect（state 由事件 / 定时器回调之外只在
  // 这里推进，与 Chat 的 heldCounts 同一个写法）。
  const [swap, setSwap] = useState<Swap>(() => ({
    stale,
    staleRows: stale ? rows : [],
    entering: NO_ENTERING,
    leaving: [],
  }));
  if (stale && (!swap.stale || !sameKeys(swap.staleRows, rows))) {
    setSwap({ stale, staleRows: rows, entering: NO_ENTERING, leaving: [] });
  } else if (!stale && swap.stale) {
    const before = new Set(swap.staleRows.map((row) => row.key));
    const after = new Set(rows.map((row) => row.key));
    setSwap({
      stale,
      staleRows: [],
      entering: new Set(
        rows.filter((row) => !before.has(row.key)).map((row) => row.key),
      ),
      // 减少动态时不留着淡出，直接拿掉。
      leaving: prefersReducedMotion()
        ? []
        : swap.staleRows.filter((row) => !after.has(row.key)),
    });
  }
  useEffect(() => {
    if (swap.leaving.length === 0) return;
    const timer = setTimeout(
      () => setSwap((prev) => ({ ...prev, leaving: [] })),
      LEAVE_MS,
    );
    return () => clearTimeout(timer);
  }, [swap.leaving]);
  const shownRows = useMemo(
    () => (swap.leaving.length > 0 ? [...rows, ...swap.leaving] : rows),
    [rows, swap.leaving],
  );
  const leavingKeys = useMemo(
    () => new Set(swap.leaving.map((row) => row.key)),
    [swap.leaving],
  );

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.syncId, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.syncId, p])),
    [projects],
  );

  // 「今天」的分界跟着这一份行算：行换了（重取、换范围）才重新读一次时钟。
  const sections = useMemo(
    () =>
      phaseSections(
        shownRows.map(toPhaseItem),
        // eslint-disable-next-line react-hooks/purity -- 分界只在行变化时读一次时钟，见上。
        startOfToday(Date.now()),
      ),
    [shownRows],
  );

  const filterItems = useMemo<
    readonly { value: PhoneFilter; label?: string; count?: number }[]
  >(
    () => [
      { value: "all" },
      { value: "attention", count: counts.attention },
      {
        value: "running",
        label: t("chat.phone.filterRunning"),
        count: counts.running,
      },
      { value: "unread", count: counts.unread },
    ],
    [counts, t],
  );

  // 搜索态是一层浮层（D1）：系统返回先退出搜索，不离开页面。
  const closeSearch = () => {
    onSearchChange("");
    setSearchOpen(false);
  };
  useBackDismiss(searchOpen, closeSearch);
  // 「取消」把搜索框连同触发它的 🔍 一起卸掉了，焦点会落到 body（D5）：退出后
  // 把焦点交给重新出现的 🔍。首次渲染就在搜索态（搜索词还在）时不抢焦点。
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const wasSearchOpen = useRef(searchOpen);
  useEffect(() => {
    if (wasSearchOpen.current && !searchOpen) searchButtonRef.current?.focus();
    wasSearchOpen.current = searchOpen;
  }, [searchOpen]);

  // 长按菜单是一层浮层（D1）：开着时系统返回只关菜单、停在原页。菜单自己不进历史，
  // 由包的 onMenuOpenChange 告知开关，宿主登记记号；返回键里把 menuOpen 置 false，
  // 包随之关掉那一个菜单。同一时刻只会有一行的菜单开着，状态记行键即可。
  const [menuRowKey, setMenuRowKey] = useState<string | null>(null);
  useBackDismiss(menuRowKey !== null, () => setMenuRowKey(null));
  // 选一项会同时「关菜单」和做事（换地址、开确认框）。菜单的记号要先退干净，动作再
  // 发生：否则动作在记号还垫在底下时 replace 了地址，useBackDismiss 随后按旧记号多退
  // 一格，刚换的范围就被退掉了（搜索态下还压着第二层记号）。flushSync 让关菜单与它的
  // 退记号 effect 在动作之前落地。
  const onRowMenuOpenChange = (key: string, open: boolean) =>
    setMenuRowKey((cur) => (open ? key : cur === key ? null : cur));
  const afterMenuClosed = (fn: (() => void) | undefined) =>
    fn &&
    (() => {
      flushSync(() => setMenuRowKey(null));
      fn();
    });

  const renderRow = (row: MirrorIndexRow) => {
    const agent = agentById.get(row.agentSyncId);
    const path = row.projectSyncId
      ? projectPath(row.projectSyncId, projectById)
      : null;
    const where = path ?? uiT("sessionIndex.free.name");
    const content = hideAgent || !agent ? where : `${agent.name} · ${where}`;
    const subline = rowSubline(row, {
      content,
      draft: drafts.get(conversationDraftKey(row.conversationId)),
      pending: outbox.get(row.conversationId),
    });
    // 长按「停止这一轮」后这一行立即写「正在停止…」，直到它不再是运行中（F2）。
    const stopping =
      stoppingRows.has(row.conversationId) &&
      row.lifecycleState === SessionLifecycle.running;
    const secondary = stopping ? (
      <span data-testid={`row-stopping-${row.key}`}>
        {t("chat.phone.stopping")}
      </span>
    ) : subline.kind === "content" ? (
      content
    ) : (
      <>
        {subline.kind === "draft" ? (
          <span className="font-medium text-destructive-text">
            {t("chat.phone.draftPrefix")}
          </span>
        ) : (
          <span>{t("chat.phone.pendingPrefix")}</span>
        )}{" "}
        <span>{subline.text || t("chat.phone.draftImageOnly")}</span>
      </>
    );
    const href =
      row.deviceId === undefined
        ? undefined
        : sessionPath({ ...row, deviceId: row.deviceId });
    const leaving = leavingKeys.has(row.key);
    const entering = swap.entering.has(row.key);
    return (
      <li
        key={row.key}
        data-stale={stale || undefined}
        data-entering={entering || undefined}
        data-leaving={leaving || undefined}
        aria-hidden={leaving || undefined}
        className={cn(
          // 旧样子：状态牌、运行 / 出错标记、未读点褪成灰（行里只有它们是 rounded-full
          // 或 status-mark），新数据到了复色。头像与文字不动。
          "[&_.rounded-full]:transition-[filter] [&_[data-slot=status-mark]]:transition-[filter] motion-reduce:[&_.rounded-full]:transition-none motion-reduce:[&_[data-slot=status-mark]]:transition-none",
          stale &&
            "[&_.rounded-full]:grayscale [&_[data-slot=status-mark]]:grayscale",
          entering &&
            "animate-in duration-300 fade-in motion-reduce:animate-none",
          leaving &&
            "pointer-events-none animate-out duration-200 fill-mode-forwards fade-out motion-reduce:animate-none",
        )}
      >
        <SessionRow
          variant="phone"
          sessionId={row.key}
          status={toAgentStatus(row)}
          title={row.title}
          highlight={searchQuery.trim() || undefined}
          unread={isRowUnread(row)}
          trailingLabel={
            row.updatedAt
              ? formatRelativeTime(row.updatedAt, i18n.language)
              : undefined
          }
          secondaryLabel={secondary}
          agent={{
            name: agent?.name ?? "",
            color: agent?.color,
            iconKey: agent?.avatarIcon,
          }}
          href={href}
          renderLink={renderLink}
          menuOpen={menuRowKey === row.key}
          onMenuOpenChange={(open) => onRowMenuOpenChange(row.key, open)}
          // 长按时这一行浮起来，菜单贴着它（规格「长按」）；长按不弹系统的链接预览。
          className="px-4 select-none [-webkit-touch-callout:none] data-[state=open]:relative data-[state=open]:z-10 data-[state=open]:bg-raised data-[state=open]:shadow-overlay"
          onStopTurn={afterMenuClosed(stopTurnOf(row))}
          onFilterAgent={afterMenuClosed(filterAgentOf(row))}
          onFilterMachine={afterMenuClosed(filterMachineOf(row))}
          onDeleteSession={
            row.saved !== false
              ? afterMenuClosed(() => onDelete(row))
              : undefined
          }
          rowActions={
            row.saved === false ? (
              <SaveButton
                testId={`row-save-${row.key}`}
                onSave={() => onSave(row)}
              />
            ) : undefined
          }
        />
      </li>
    );
  };

  const searching = searchQuery.trim() !== "";
  let body: ReactNode;
  if (!settled) {
    body = (
      // phone 骨架与真实手机行同一副几何（64px 行、44px 圆角头像）；骨架行自带
      // px-2，外面再补 px-2，左缘与真实行（li 的 px-4）对齐，落地时列表不跳。
      <div className="px-2">
        <SessionRowSkeleton variant="phone" />
      </div>
    );
  } else if (rows.length === 0 && loadFailed) {
    // 原因与出口经分类（规格 G1、G2）：502 / 门户页说「服务暂时不可用（状态码）」，
    // 401 的出口是重新登录——重试只会再得一个 401。原文不上屏。
    const failure =
      loadError === undefined
        ? null
        : describeFailure(loadError, {
            t,
            what: t("sessionIndex.loadFailedWhat"),
          });
    body = (
      <div className="px-6 py-8">
        <EmptyState
          icon={TriangleAlert}
          tone="danger"
          title={t("chat.phone.loadFailed.title")}
          body={failure?.message ?? t("chat.phone.loadFailed.body")}
          testId="chat-load-failed"
          action={
            failure?.exit === "signIn" ? (
              <Button asChild size="lg" className="h-11 w-full">
                <a
                  href={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
                >
                  {t("common.failure.signIn")}
                </a>
              </Button>
            ) : (
              <Button size="lg" className="h-11 w-full" onClick={onRetry}>
                <RotateCw aria-hidden="true" />
                {t("sessionIndex.loadMore.retry")}
              </Button>
            )
          }
        />
      </div>
    );
  } else if (rows.length === 0 && (filter !== "all" || searching)) {
    body = (
      <SessionIndexEmpty
        filter={filter}
        searching={searching}
        total={accountTotal}
        onShowAll={() => onFilterChange("all")}
        onClearSearch={() => onSearchChange("")}
      />
    );
  } else if (rows.length === 0) {
    body = (
      <div className="px-6 py-8">
        <EmptyState
          icon={MessageCirclePlus}
          title={t("chat.noSessions")}
          body={t(noDevice ? "chat.noDeviceBody" : "chat.startFirstBody")}
          testId="chat-empty-state"
          action={
            noDevice ? (
              <Button asChild size="lg" className="h-11 w-full">
                <Link to="/devices">{t("chat.addDevice")}</Link>
              </Button>
            ) : (
              <>
                <Button size="lg" className="h-11 w-full" onClick={onCompose}>
                  {t("chat.startNew")}
                </Button>
                {hasOnlineMachine ? (
                  <Button
                    variant="link"
                    className="min-h-11"
                    onClick={onFindOnMachine}
                  >
                    {t("chat.findOnMachine")}
                  </Button>
                ) : (
                  <Link
                    to="/devices"
                    className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-primary-text hover:underline"
                  >
                    {t("chat.addDevice")}
                  </Link>
                )}
              </>
            )
          }
        />
      </div>
    );
  } else {
    body = (
      // 换范围在途时整块变淡但不禁用：旧行照样点得开（决策 5）。
      <div
        data-testid="chat-phone-rows"
        className={cn(
          "transition-opacity motion-reduce:transition-none",
          refreshing && "opacity-55",
        )}
      >
        {sections.map((section) => (
          <section
            key={section.key}
            data-testid={`phase-${section.key}`}
            aria-labelledby={`phase-${section.key}-title`}
          >
            <h2
              id={`phase-${section.key}-title`}
              className="flex items-center gap-2 px-4 pt-3 pb-0.5 text-xs font-semibold text-muted-foreground"
            >
              {t(SECTION_LABEL[section.key])}
              {syncing ? (
                <span className="inline-flex items-center gap-1 text-3xs font-normal text-decorative-foreground">
                  <LoaderCircle
                    className="size-3 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {t("chat.phone.syncing")}
                </span>
              ) : null}
            </h2>
            <ul>{section.items.map(renderRow)}</ul>
          </section>
        ))}
        {(hasMore || loadMoreFailed) && (
          <div className="px-4">
            <LoadMore
              loading={loadingMore}
              failed={loadMoreFailed}
              onLoadMore={onLoadMore}
            />
          </div>
        )}
        {searching ? (
          <p className="px-8 pt-3.5 pb-6 text-center text-xs leading-relaxed text-muted-foreground">
            {t("chat.phone.searchNote")}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        data-testid="chat-mobile-header"
        // 这一条顶栏由页面自己排（壳走 ownHeader），安全区也得自己让。
        className="relative shrink-0 bg-sheet pt-[env(safe-area-inset-top,0px)]"
      >
        {searchOpen ? (
          <div className="flex h-[52px] items-center gap-1 pr-1 pl-3">
            <SearchInput
              size="md"
              value={searchQuery}
              onChange={onSearchChange}
              aria-label={t("chat.phone.search")}
              placeholder={t("chat.phone.search")}
              autoFocus
              className="min-w-0 flex-1"
              inputClassName="text-base"
            />
            <Button
              variant="ghost"
              className="h-11 px-2.5 text-primary-text"
              onClick={closeSearch}
            >
              {t("chat.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex h-[52px] items-center gap-1 px-3">
            <MobileNavButton />
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={t("chat.phone.scopeAria", { name: scopeTitle })}
              aria-describedby="chat-phone-subtitle"
              onClick={onOpenScope}
              className="flex h-11 min-w-0 flex-1 flex-col items-center justify-center rounded-md outline-none focus-visible:focus-outline"
            >
              <span className="flex max-w-full items-center gap-1 text-prose leading-tight font-bold text-foreground">
                <span className="truncate">{scopeTitle}</span>
                <ChevronDown
                  className="size-3.5 shrink-0 text-decorative-foreground"
                  aria-hidden="true"
                />
              </span>
              <span
                id="chat-phone-subtitle"
                data-testid="chat-phone-subtitle"
                className="mt-0.5 flex max-w-full items-center gap-1 text-3xs leading-tight text-muted-foreground"
              >
                {subtitle.dot ? (
                  <StatusDot
                    // 在线点同样是实时标记：旧样子时置灰。
                    status={stale ? "idle" : subtitle.dot}
                    size="xs"
                    aria-hidden="true"
                    aria-label={undefined}
                  />
                ) : null}
                <span className="truncate">
                  {syncing
                    ? t("chat.phone.updatingSubtitle", { text: subtitle.text })
                    : subtitle.text}
                </span>
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              ref={searchButtonRef}
              aria-label={t("chat.phone.search")}
              onClick={() => setSearchOpen(true)}
            >
              <Search className="size-5" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 text-primary-text"
              aria-label={t("chat.startNew")}
              onClick={onCompose}
            >
              <SquarePen className="size-5" aria-hidden="true" />
            </Button>
          </div>
        )}
        {searchOpen ? (
          <p
            data-testid="chat-phone-search-scope"
            className="px-4 pb-2 text-xs text-muted-foreground"
          >
            {t("chat.phone.searchScope", {
              scope: scopeTitle,
              count: searchCount,
            })}
          </p>
        ) : (
          <SessionFilterChips<PhoneFilter>
            value={filter}
            items={filterItems}
            size="touch"
            onChange={onFilterChange}
            // chip 视觉 32px，点按区靠 ::before 上下各撑 6px；横向滚动会把纵向溢出一起裁掉，
            // 所以上下各留 6px（上边用 -mt-1.5 抵掉，排版不变），撑出来的 44px 才点得到。
            className="-mt-1.5 overflow-x-auto px-3 pt-1.5 pb-2.5"
          />
        )}
        {/* 贴着页头底边（筛选条下，搜索时在命中句下），出现与消失都不推动列表。 */}
        {(refreshing || syncing) && settled ? (
          <IndexRefreshBar className="bottom-0" />
        ) : null}
      </header>
      {/* 页头下方、列表之上：占自己的一行，不压在筛选条或行上。 */}
      {unstable ? <IdentityUnstableStrip /> : null}
      <div
        ref={listRef}
        data-testid="chat-phone-list"
        aria-busy={!settled || refreshing || syncing || undefined}
        onScroll={onScroll}
        onClickCapture={onListClickCapture}
        className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]"
      >
        {banners ? <div className="space-y-3 px-4 pt-3">{banners}</div> : null}
        {body}
      </div>
    </div>
  );
}
