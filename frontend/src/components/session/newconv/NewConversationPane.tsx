import { ChevronRight, FolderTree } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@agentre-hub/agentre-ui";

import { AgentPickList } from "./AgentPickList";
import type { NewConvAgent } from "./types";

/**
 * 桌面端「挑一个 Agent」：占的是右栏——那块地方本来摆的是「挑一条对话」空态，
 * 现在由它接管。桌面不需要弹层：右栏就是空着的，把选择摆在那儿比在屏幕中间
 * 盖一层要轻。
 */
export function NewConversationPane({
  agents,
  recentIds,
  onPick,
  onFromProject,
  settled = true,
}: {
  agents: NewConvAgent[];
  recentIds: string[];
  onPick: (agent: NewConvAgent) => void;
  /** 通向「从项目里挑一个 Agent」。 */
  onFromProject: () => void;
  /** 清单问回来了没有。没回来时清单那一格摆骨架，不说「一个都没有」。 */
  settled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterAgents(agents, query), [agents, query]);

  return (
    <div
      data-testid="new-conversation-pane"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-card px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold text-foreground">
            {t("chat.startNew")}
          </h2>
          <SearchInput
            value={query}
            onChange={setQuery}
            aria-label={t("chat.searchAgents")}
            placeholder={t("chat.searchAgents")}
            className="ml-auto w-[220px]"
          />
        </div>
        <p className="text-[11.5px] leading-[1.5] text-muted-foreground">
          {t("chat.pickAgentHint")}
        </p>
      </header>

      <div
        aria-busy={!settled || undefined}
        className="min-h-0 flex-1 overflow-auto px-5 py-4"
      >
        <AgentPickList
          agents={filtered}
          recentIds={recentIds}
          onPick={onPick}
          columns={2}
          search={{ query, onClear: () => setQuery("") }}
          settled={settled}
        />
      </div>

      <button
        type="button"
        data-testid="new-conversation-from-project"
        onClick={onFromProject}
        className="flex shrink-0 items-center gap-2.5 border-t border-border bg-card px-5 py-3 text-left transition-colors hover:bg-accent"
      >
        <span className="flex size-7 items-center justify-center rounded-md bg-secondary text-muted-foreground">
          <FolderTree aria-hidden="true" className="size-3.5" />
        </span>
        <span className="text-[12.5px] font-medium text-foreground">
          {t("chat.fromProject")}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="ml-auto size-4 text-decorative-foreground"
        />
      </button>
    </div>
  );
}

/** 只按名字过滤：这一层没有别的可搜的东西（机器名会随在线态变，搜它会飘）。 */
export function filterAgents(
  agents: NewConvAgent[],
  query: string,
): NewConvAgent[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) => a.name.toLowerCase().includes(q));
}
