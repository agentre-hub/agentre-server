import {
  Button,
  SearchInput,
  SessionFilterChips,
  SessionIndexEmpty,
  SessionRow,
  SessionRowSkeleton,
  StatusDot,
  phaseSections,
  useUiTranslation,
  type AgentStatus,
  type PhaseSectionKey,
  type SessionRowLinkRenderer,
} from "@agentre-hub/agentre-ui";
import {
  ChevronDown,
  MessageCirclePlus,
  Search,
  SquarePen,
} from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { EmptyState, MobileNavButton } from "@/components/console";
import {
  LoadMore,
  SaveButton,
  type SessionIndexAgent,
  type SessionPathTarget,
} from "@/components/session/SessionIndex";
import { toAgentStatus } from "@/lib/attentionAdapter";
import type { ProjectNode } from "@/lib/projects";
import { formatRelativeTime } from "@/lib/sessionView";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import {
  isRowUnread,
  startOfToday,
  toPhaseItem,
  type PhoneCounts,
  type PhoneFilter,
} from "@/pages/chat/phoneRows";

/**
 * 手机首页的滚动位置，按范围记（规格 2026-11-05「首页」返回恢复）。
 *
 * 打开一条对话时这一屏整个让给详情（Chat 在手机上不留第二栏），列表的 DOM 随之卸掉；
 * 返回时按范围把位置放回去。模块级而不是组件状态：卸掉的组件留不住任何东西。
 * 筛选不用记在这里——它是 Chat 的状态，Chat 在 `/chat` 与 `/chat/:id` 之间不卸载。
 */
const scrollMemory = new Map<string, number>();

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

  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  onLoadMore: () => void;
  /** 列表之上的横幅（取数失败、保存失败）。 */
  banners?: ReactNode;
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
  hasMore,
  loadingMore,
  loadMoreFailed,
  onLoadMore,
  banners,
}: PhoneChatIndexProps) {
  const { t, i18n } = useTranslation();
  const { t: uiT } = useUiTranslation();
  // 搜索词还在（从对话返回）时，回来仍是搜索那一屏。
  const [searchOpen, setSearchOpen] = useState(() => searchQuery !== "");
  const listRef = useRef<HTMLDivElement>(null);

  // 位置在列表真的摆出来之后才放回去：骨架那一刻放回去会被内容撑开时冲掉。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !settled) return;
    el.scrollTop = scrollMemory.get(scopeKey) ?? 0;
  }, [scopeKey, settled]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (el) scrollMemory.set(scopeKey, el.scrollTop);
  }, [scopeKey]);

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
        rows.map(toPhaseItem),
        // eslint-disable-next-line react-hooks/purity -- 分界只在行变化时读一次时钟，见上。
        startOfToday(Date.now()),
      ),
    [rows],
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

  const closeSearch = () => {
    onSearchChange("");
    setSearchOpen(false);
  };

  const renderRow = (row: MirrorIndexRow) => {
    const agent = agentById.get(row.agentSyncId);
    const path = row.projectSyncId
      ? projectPath(row.projectSyncId, projectById)
      : null;
    const where = path ?? uiT("sessionIndex.free.name");
    const secondary = hideAgent || !agent ? where : `${agent.name} · ${where}`;
    const href =
      row.deviceId === undefined
        ? undefined
        : sessionPath({ ...row, deviceId: row.deviceId });
    return (
      <li key={row.key}>
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
          // 长按时这一行浮起来，菜单贴着它（规格「长按」）；长按不弹系统的链接预览。
          className="px-4 select-none [-webkit-touch-callout:none] data-[state=open]:relative data-[state=open]:z-10 data-[state=open]:bg-raised data-[state=open]:shadow-overlay"
          onStopTurn={stopTurnOf(row)}
          onFilterAgent={filterAgentOf(row)}
          onFilterMachine={filterMachineOf(row)}
          onDeleteSession={
            row.saved !== false ? () => onDelete(row) : undefined
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
      <div className="px-4 py-3">
        <SessionRowSkeleton />
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
          body={t("chat.startFirstBody")}
          testId="chat-empty-state"
          action={
            <>
              <Button size="lg" className="w-full" onClick={onCompose}>
                {t("chat.startNew")}
              </Button>
              {hasOnlineMachine ? (
                <Button variant="link" onClick={onFindOnMachine}>
                  {t("chat.findOnMachine")}
                </Button>
              ) : (
                <Link
                  to="/devices"
                  className="text-sm font-medium text-primary-text hover:underline"
                >
                  {t("chat.addDevice")}
                </Link>
              )}
            </>
          }
        />
      </div>
    );
  } else {
    body = (
      <>
        {sections.map((section) => (
          <section
            key={section.key}
            data-testid={`phase-${section.key}`}
            aria-labelledby={`phase-${section.key}-title`}
          >
            <h2
              id={`phase-${section.key}-title`}
              className="px-4 pt-3 pb-0.5 text-xs font-semibold text-muted-foreground"
            >
              {t(SECTION_LABEL[section.key])}
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
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        data-testid="chat-mobile-header"
        // 这一条顶栏由页面自己排（壳走 ownHeader），安全区也得自己让。
        className="shrink-0 bg-sheet pt-[env(safe-area-inset-top,0px)]"
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
                    status={subtitle.dot}
                    size="xs"
                    aria-hidden="true"
                    aria-label={undefined}
                  />
                ) : null}
                <span className="truncate">{subtitle.text}</span>
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
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
            className="overflow-x-auto px-3 pb-1"
          />
        )}
      </header>
      <div
        ref={listRef}
        data-testid="chat-phone-list"
        aria-busy={!settled || undefined}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]"
      >
        {banners ? <div className="space-y-3 px-4 pt-3">{banners}</div> : null}
        {body}
      </div>
    </div>
  );
}
