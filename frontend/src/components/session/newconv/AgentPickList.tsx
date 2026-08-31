import {
  AgentAvatar,
  Button,
  cn,
  groupAgentsForPicking,
} from "@agentre-hub/agentre-ui";
import { Bot, ChevronRight, SearchX } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/**
 * 组标题与计数之间的分隔符。是排版符号不是文案，因此不进 i18n——写成常量
 * 而不是 JSX 里的字面量，也是为了让 `i18next/no-literal-string` 不用为它开例外
 * （与 SessionIndex 的 DIMENSION_SEPARATOR 同一条理由）。
 */
const COUNT_SEPARATOR = " · ";

import { EmptyState } from "@/components/console";

import { targetSummary, type NewConvAgent } from "./types";

/**
 * 「挑一个 Agent」的清单。桌面右栏与移动底部弹层共用同一份——两处如果各写一遍，
 * 分组规则和「跑不了」的判据就会各漂各的。
 *
 * 三组，顺序固定：最近用过 → 可以开 → 现在开不了。
 *
 *   - 跑不了的**不隐藏也不可点**：藏起来会让人以为 Agent 丢了，可点则是把死路
 *     留到点完之后才说（旧弹层就是这样：选完才告诉你「现在选不了」）。
 *   - 「最近用过」为空时整组不渲染，不摆一个空标题。
 */
export function AgentPickList({
  agents,
  recentIds,
  onPick,
  columns = 1,
  search,
}: {
  agents: NewConvAgent[];
  recentIds: string[];
  onPick: (agent: NewConvAgent) => void;
  columns?: 1 | 2;
  /**
   * 宿主正按词收窄时给。空态要分得清「账号里没有 Agent」与「这次搜索不收」——
   * 后者东西还在，回程是清掉那个词，所以清空的能力必须一起传进来（贴底弹层
   * 没有搜索框，它不给）。
   */
  search?: { query: string; onClear: () => void };
}) {
  const { t } = useTranslation();

  const groups = useMemo(() => {
    // 分组与排序走共享包：桌面端命令面板的 `flattenAgents` 是同一条规则（判据是
    // chattable 而不是 has_available_target，结论同名），此前两端各写了一份。
    // 「最近用过」按记录顺序走、不重排成账号顺序——它的价值就是那个顺序；
    // 跑不了的不进这一组，也不隐藏。这些都由包那只函数负责，这里只摆标题。
    //
    // 本站没有「置顶」，所以不传 pinned。
    const { recent, available, unavailable } = groupAgentsForPicking({
      agents,
      key: (a) => a.sync_id,
      available: (a) => a.has_available_target,
      recentKeys: recentIds,
    });
    return [
      { key: "recent", label: t("chat.recentAgents"), items: recent },
      { key: "available", label: t("chat.availableAgents"), items: available },
      {
        key: "unavailable",
        label: t("chat.unavailableAgents"),
        items: unavailable,
      },
    ].filter((g) => g.items.length > 0);
  }, [agents, recentIds, t]);

  // 这一格是「新建对话」的主体区，不是索引窄栏：用页面级 `EmptyState`。
  // 两句都归 chat 命名空间——此前「账号里没有 Agent」借的是总览页的
  // `overview.empty`，借来的键别人改名时这里不报错，只在运行时印裸键号。
  if (agents.length === 0) {
    return search?.query ? (
      <EmptyState
        testId="agent-pick-empty"
        icon={SearchX}
        title={t("chat.noAgentMatchesTitle")}
        body={t("chat.noAgentMatchesBody")}
        action={
          <Button variant="outline" size="sm" onClick={search.onClear}>
            {t("chat.clearAgentSearch")}
          </Button>
        }
      />
    ) : (
      <EmptyState
        testId="agent-pick-empty"
        icon={Bot}
        // 只说「还没有 Agent」是半句：得说清楚它们从哪来，否则读者不知道下一步。
        title={t("chat.noAgentsTitle")}
        body={t("chat.noAgentsBody")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-2">
          <h3
            data-testid={`agent-group-${group.key}`}
            className="text-2xs font-semibold text-decorative-foreground"
          >
            {group.label}
            <span aria-hidden="true">{`${COUNT_SEPARATOR}${group.items.length}`}</span>
          </h3>
          <ul
            className={cn(
              "grid gap-2.5",
              columns === 2 ? "grid-cols-2" : "grid-cols-1",
            )}
          >
            {group.items.map((agent) => (
              <li key={agent.sync_id}>
                <AgentRow agent={agent} onPick={onPick} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AgentRow({
  agent,
  onPick,
}: {
  agent: NewConvAgent;
  onPick: (agent: NewConvAgent) => void;
}) {
  const { t } = useTranslation();
  const runnable = agent.has_available_target;
  return (
    <button
      type="button"
      data-testid={`agent-pick-${agent.sync_id}`}
      disabled={!runnable}
      // 跑不了时禁用而不是移除：读屏用户也要读得到「它在，只是现在开不了，原因是…」。
      aria-disabled={!runnable}
      onClick={() => onPick(agent)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors",
        runnable
          ? "bg-card hover:border-ring hover:bg-accent"
          : "cursor-not-allowed bg-secondary",
      )}
    >
      <AgentAvatar name={agent.name} color={agent.avatar_color} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-aux font-semibold",
            runnable ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {agent.name}
        </span>
        <span
          data-testid={`agent-pick-${agent.sync_id}-target`}
          className={cn(
            "truncate text-2xs",
            runnable ? "text-muted-foreground" : "text-status-waiting-text",
          )}
        >
          {targetSummary(agent, t)}
        </span>
      </span>
      {runnable && (
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-decorative-foreground"
        />
      )}
    </button>
  );
}
