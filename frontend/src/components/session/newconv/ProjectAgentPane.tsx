import { AgentAvatar, ProjectGlyph, cn } from "@agentre-hub/agentre-ui";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 组标题与计数之间的分隔符。是排版符号不是文案，因此不进 i18n——写成常量
 * 而不是 JSX 里的字面量，也是为了让 `i18next/no-literal-string` 不用为它开例外
 * （与 SessionIndex 的 DIMENSION_SEPARATOR 同一条理由）。
 */
const COUNT_SEPARATOR = " · ";

import { membersOfProject } from "./projectMembers";
import { targetSummary, type NewConvAgent, type NewConvProject } from "./types";

/**
 * 「从项目里挑一个 Agent」：左边项目树，右边这个项目里的 Agent。
 *
 * 桌面够宽，所以设计稿上移动端的两跳（选项目 → 选 Agent）在这里并成一屏：
 * 换项目时右边当场跟着换，不用来回退。
 */
export function ProjectAgentPane({
  projects,
  agents,
  onPick,
  onBack,
  stacked = false,
}: {
  projects: NewConvProject[];
  agents: NewConvAgent[];
  onPick: (agent: NewConvAgent) => void;
  onBack: () => void;
  /**
   * 窄屏：项目树改成顶上一条横向 chip 条。390px 上再摆一列 252px 的树，
   * 右边只剩 138px，两边都用不了。
   */
  stacked?: boolean;
}) {
  const { t } = useTranslation();
  const ordered = useMemo(() => orderProjectTree(projects), [projects]);
  const [selected, setSelected] = useState<string | null>(
    ordered[0]?.project.sync_id ?? null,
  );

  const members = useMemo(
    () =>
      selected
        ? membersOfProject(selected, projects, agents)
        : { direct: [], inherited: [] },
    [agents, projects, selected],
  );
  const selectedProject = projects.find((p) => p.sync_id === selected) ?? null;

  return (
    <div
      data-testid="project-agent-pane"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-3.5">
        <button
          type="button"
          aria-label={t("chat.back")}
          onClick={onBack}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
        <h2 className="text-sm font-semibold text-foreground">
          {t("chat.fromProject")}
        </h2>
      </header>

      <div className={cn("flex min-h-0 flex-1", stacked && "flex-col")}>
        <nav
          data-testid="project-tree"
          aria-label={t("chat.projects")}
          className={cn(
            "bg-card",
            stacked
              ? "flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2"
              : "flex w-[252px] shrink-0 flex-col gap-0.5 overflow-auto border-r border-border p-2",
          )}
        >
          {ordered.length === 0 ? (
            <p className="px-2 py-1.5 text-[11.5px] text-muted-foreground">
              {t("chat.noProjects")}
            </p>
          ) : (
            ordered.map(({ project, depth }) => (
              <button
                key={project.sync_id}
                type="button"
                data-testid={`project-node-${project.sync_id}`}
                aria-current={selected === project.sync_id ? "true" : undefined}
                onClick={() => setSelected(project.sync_id)}
                style={stacked ? undefined : { paddingLeft: 8 + depth * 14 }}
                className={cn(
                  "flex items-center gap-2 rounded-md text-left transition-colors",
                  stacked
                    ? "shrink-0 border border-border px-2.5 py-1.5"
                    : "py-1.5 pr-2",
                  selected === project.sync_id
                    ? "bg-sidebar-selected-bg"
                    : "hover:bg-accent",
                )}
              >
                <ProjectGlyph
                  project={{ name: project.name, color: project.color }}
                />
                <span
                  className={cn(
                    "truncate text-[12.5px] font-medium",
                    selected === project.sync_id
                      ? "text-primary-text"
                      : "text-foreground",
                  )}
                >
                  {project.name}
                </span>
              </button>
            ))
          )}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {selectedProject && (
            <div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-card px-5 py-2.5">
              <ProjectGlyph
                project={{
                  name: selectedProject.name,
                  color: selectedProject.color,
                }}
                className="size-6 rounded-md text-2xs"
              />
              <span className="truncate text-sm font-semibold text-foreground">
                {selectedProject.name}
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {/* 一个项目都还没有：这一半不能谈论「这个项目」——没有那个项目。
                左边已经说了「还没有项目」，这里接着说该去哪儿建，而不是让两句话
                一起把用户送去找一个不存在的项目。 */}
            {!selectedProject ? (
              <p
                data-testid="project-none-yet"
                className="text-sm text-muted-foreground"
              >
                {t("chat.noProjectsYetHint")}
              </p>
            ) : members.direct.length === 0 &&
              members.inherited.length === 0 ? (
              <p
                data-testid="project-agents-empty"
                className="text-sm text-muted-foreground"
              >
                {t("chat.noAgentsInProject")}
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <MemberGroup
                  testId="direct"
                  label={t("chat.directMembers")}
                  agents={members.direct}
                  onPick={onPick}
                />
                <MemberGroup
                  testId="inherited"
                  label={t("chat.inheritedMembers")}
                  agents={members.inherited}
                  onPick={onPick}
                  tag={t("chat.inheritedTag")}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MemberGroup({
  testId,
  label,
  agents,
  onPick,
  tag,
}: {
  testId: string;
  label: string;
  agents: NewConvAgent[];
  onPick: (agent: NewConvAgent) => void;
  tag?: string;
}) {
  const { t } = useTranslation();
  if (agents.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3
        data-testid={`project-members-${testId}`}
        className="text-2xs font-semibold text-decorative-foreground"
      >
        {label}
        <span aria-hidden="true">{`${COUNT_SEPARATOR}${agents.length}`}</span>
      </h3>
      <ul className="flex flex-col gap-2">
        {agents.map((agent) => (
          <li key={agent.sync_id}>
            <button
              type="button"
              data-testid={`project-agent-${agent.sync_id}`}
              disabled={!agent.has_available_target}
              aria-disabled={!agent.has_available_target}
              onClick={() => onPick(agent)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors",
                agent.has_available_target
                  ? "bg-card hover:border-ring hover:bg-accent"
                  : "cursor-not-allowed bg-secondary",
              )}
            >
              <AgentAvatar
                name={agent.name}
                color={agent.avatar_color}
                size="sm"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "truncate text-aux font-semibold",
                      agent.has_available_target
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {agent.name}
                  </span>
                  {tag && (
                    <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-3xs font-medium text-decorative-foreground">
                      {tag}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "truncate text-2xs",
                    agent.has_available_target
                      ? "text-muted-foreground"
                      : "text-status-waiting-text",
                  )}
                >
                  {targetSummary(agent, t)}
                </span>
              </span>
              {agent.has_available_target && (
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-decorative-foreground"
                />
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 把项目树压成一列可渲染的行（父在前、子紧随其后、按 sort_order 再按名字）。
 *
 * 父不存在的节点（父被删了 / 还没同步到）按根处理：树里少一层比整棵树少一枝好。
 */
export function orderProjectTree(
  projects: NewConvProject[],
): { project: NewConvProject; depth: number }[] {
  const byId = new Map(projects.map((p) => [p.sync_id, p]));
  const childrenOf = new Map<string, NewConvProject[]>();
  for (const p of projects) {
    const parent =
      p.parent_sync_id && byId.has(p.parent_sync_id) ? p.parent_sync_id : "";
    const list = childrenOf.get(parent) ?? [];
    list.push(p);
    childrenOf.set(parent, list);
  }
  for (const list of childrenOf.values()) {
    list.sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }
  const out: { project: NewConvProject; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const p of childrenOf.get(parent) ?? []) {
      // 成环时停在第二次遇见的那一个：列不全好过挂死。
      if (seen.has(p.sync_id)) continue;
      seen.add(p.sync_id);
      out.push({ project: p, depth });
      walk(p.sync_id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
