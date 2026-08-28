import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  Bot,
  CalendarDays,
  Flame,
  FolderTree,
  MessagesSquare,
  Monitor,
} from "lucide-react";

import { EmptyState, Metric } from "@/components/console";
import {
  Alert,
  Button,
  cn,
  orgBackendTypeLabel,
} from "@agentre-hub/agentre-ui";
import AppShell from "@/components/AppShell";
import {
  Heatmap,
  HeatmapLegend,
  HEATMAP_DESKTOP_WEEKS,
  HEATMAP_MOBILE_WEEKS,
} from "@/components/stats/Heatmap";
import { useIsMobile } from "@/components/use-is-mobile";
import { useAccountChannel } from "@/hooks/use-account-channel";
import { useAliveEffect } from "@/hooks/use-api-query";
import {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
  AccountChannelSyncVersion,
} from "@/lib/accountChannel";
import { api } from "@/lib/api";
import { fetchDevices, type DeviceItem } from "@/lib/devices";
import { loadErrorText } from "@/lib/loadError";
import { fetchProjects, type ProjectNode } from "@/lib/projects";
import {
  fetchStatsOverview,
  STATS_RANGES,
  type StatsOverview,
  type StatsRange,
} from "@/lib/stats";

/** 设置页的隐私页签：热力卡头与 scope 说明条都指到这里。 */
const PRIVACY_SETTINGS_PATH = "/settings?tab=privacy";

// 与 workspace_svc.AvailabilityXxx 的字符串常量一一对应。
type Availability = "available" | "offline" | "unpaired" | "no_device";

/**
 * `/v1/workspace/agents` 的一档执行目标。
 *
 * 总览只读**当前落到哪台**这一件事：逐档排序留在组织页（`OrgExecTargetSection`），
 * 一份能力两个入口只会各自漂。R19：path / cli_path / env_json 在这一层就没有对应
 * 字段，所以即使响应里混进来也无处渲染。
 */
interface ExecTargetItem {
  rank: number;
  is_local_reference: boolean;
  device_id?: number;
  device_name?: string;
  backend_type?: string;
  availability: Availability;
  current: boolean;
}

interface AgentItem {
  sync_id: string;
  name: string;
  avatar_color?: string;
  department_name?: string;
  exec_targets: ExecTargetItem[];
  has_available_target: boolean;
}

// ── TopBar 的 Fresh 指示 ────────────────────────────────────────────────
// 桌面端（agentred）有在线机器才算「已连接」；未连 / 未知则不渲染，不编状态。
function Fresh({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  if (!connected) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-[6px] rounded-full bg-status-running"
      />
      <span className="text-xs text-muted-foreground">
        {t("appShell.topBar.fresh")}
      </span>
    </span>
  );
}

// ── 顶栏右侧的范围分段控件 ───────────────────────────────────────────────
// 只管统计区：热力图始终是一年，不跟着变（口径说明板「范围控件」）。
function RangeSwitch({
  value,
  onChange,
}: {
  value: StatsRange;
  onChange: (next: StatsRange) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("overview.stats.range.label")}
      className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5"
    >
      {STATS_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={value === range}
          onClick={() => onChange(range)}
          className={cn(
            "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
            value === range
              ? "bg-primary-soft text-primary-text"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          {t(`overview.stats.range.${range}`)}
        </button>
      ))}
    </div>
  );
}

// ── 卡壳 ────────────────────────────────────────────────────────────────
function StatsCard({
  title,
  meta,
  action,
  testId,
  children,
  className,
}: {
  title: string;
  meta?: string | null;
  action?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cn(
        "flex min-w-0 flex-col rounded-lg border border-border bg-card",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pt-4">
        <h2 className="text-sm font-bold text-foreground">{title}</h2>
        {meta ? (
          <span className="text-xs text-muted-foreground">{meta}</span>
        ) : null}
        <span className="flex-1" />
        {action}
      </div>
      <div className="min-w-0 px-4 pt-3 pb-4">{children}</div>
    </section>
  );
}

/** 一根占比条。宽度是这一行相对最大值的比例，永远至少留一点可见宽度。 */
function Bar({
  ratio,
  className,
  style,
}: {
  ratio: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const width = Math.max(2, Math.min(100, Math.round(ratio * 100)));
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span
        className={cn("block h-full rounded-full", className)}
        style={{ width: `${width}%`, ...style }}
      />
    </span>
  );
}

/** 项目 / 模型的条按名次取色，最活跃的那档最深。 */
const RANK_HEAT = ["bg-heat-4", "bg-heat-3", "bg-heat-2", "bg-heat-1"];
function rankHeat(index: number): string {
  return RANK_HEAT[Math.min(index, RANK_HEAT.length - 1)];
}

/** 后端占比条的分段色。「未上报」那一段固定用 status-idle，不占调色板。 */
const BACKEND_TONES = [
  "bg-agent-5",
  "bg-agent-3",
  "bg-agent-9",
  "bg-agent-11",
  "bg-agent-16",
];

// ── 骨架 ────────────────────────────────────────────────────────────────
function TileSkeletons() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          data-testid="tile-skeleton"
          aria-hidden="true"
          className="flex min-w-0 flex-col gap-2.5 rounded-md border border-border bg-card px-3.5 py-3"
        >
          <span className="h-[11px] w-16 rounded-sm bg-muted" />
          <span className="h-6 w-12 rounded-sm bg-muted" />
          <span className="h-2 w-24 rounded-sm bg-muted" />
        </div>
      ))}
    </>
  );
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <span className="h-[11px] w-24 rounded-sm bg-muted" />
          <span className="h-1.5 w-full rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}

export default function Overview() {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();

  const [range, setRange] = useState<StatsRange>("30d");
  /** 手动重试用的一次性游标：改它即让取数 effect 重跑一轮。 */
  const [reloadKey, setReloadKey] = useState(0);

  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [statsError, setStatsError] = useState<unknown>(null);

  // 三份辅助数据都是锦上添花：取不到就保持空，对应的那一段不画，不阻塞整页。
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [agents, setAgents] = useState<AgentItem[] | null>(null);
  const [projects, setProjects] = useState<ProjectNode[] | null>(null);

  useAliveEffect(
    (alive) => {
      fetchStatsOverview(range)
        .then((got) => {
          if (!alive()) return;
          setStats(got);
          setStatsError(null);
        })
        .catch((e: unknown) => {
          // 一律存真值：reject(undefined) 是存在的，原样存进去会让页面永远停在骨架上。
          if (alive()) setStatsError(e ?? new Error("stats load failed"));
        });
    },
    [range, reloadKey],
  );

  const loadWorkspace = useCallback(() => {
    api<{ agents?: AgentItem[] }>("/v1/workspace/agents")
      .then((got) => setAgents(got.agents ?? []))
      .catch(() => {});
    fetchProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);

  const loadDevices = useCallback(() => {
    fetchDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);

  useAliveEffect(() => {
    loadDevices();
    loadWorkspace();
  }, [loadDevices, loadWorkspace]);

  // 各订各的那一类：一条对话存进账号不该让 Agent 名单也重取一遍。
  useAccountChannel([AccountChannelDevicePresence], loadDevices);
  useAccountChannel([AccountChannelSyncVersion], loadWorkspace);
  useAccountChannel([AccountChannelMirrorChanged], () =>
    setReloadKey((k) => k + 1),
  );

  const desktopConnected = useMemo(
    () => (devices ?? []).some((d) => d.kind === "agentred" && d.online),
    [devices],
  );
  const firstOffline = useMemo(
    () => (devices ?? []).find((d) => !d.online),
    [devices],
  );
  const agentsBySync = useMemo(
    () => new Map((agents ?? []).map((a) => [a.sync_id, a])),
    [agents],
  );
  const projectsBySync = useMemo(
    () => new Map((projects ?? []).map((p) => [p.syncId, p])),
    [projects],
  );

  const rangeLabel = t(`overview.stats.range.${range}`);
  const heatmapWeeks = isMobile ? HEATMAP_MOBILE_WEEKS : HEATMAP_DESKTOP_WEEKS;

  const monthRange = useMemo(() => {
    if (!stats) return "";
    const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
      year: "numeric",
      month: "long",
      timeZone: "UTC",
    });
    const at = (day: string) => fmt.format(new Date(`${day}T00:00:00Z`));
    return `${at(stats.heatmap.from)} — ${at(stats.heatmap.to)}`;
  }, [stats, i18n.resolvedLanguage]);

  const statsErrorMessage =
    statsError !== null
      ? loadErrorText(statsError, t, "overview.stats.error.alert")
      : null;

  const summary = stats?.summary;
  /** 这个账号还什么都没发生过：0 设备 0 对话。 */
  const freshAccount =
    summary !== undefined &&
    summary.conversations_total === 0 &&
    summary.devices_total === 0;
  /** 一条历史都没有：连续活跃 / 活跃天此时给不出有意义的 0。 */
  const noHistory = summary !== undefined && summary.conversations_total === 0;

  return (
    <AppShell
      title={t("nav.overview")}
      right={
        <div className="flex min-w-0 items-center gap-3">
          <Fresh connected={desktopConnected} />
          <RangeSwitch value={range} onChange={setRange} />
        </div>
      }
    >
      <div className="mx-auto w-full max-w-[1200px] space-y-4">
        {/* 范围收窄时页顶一条说明覆盖全页，不逐卡重复。 */}
        {stats?.scope === "saved" ? (
          <div
            data-testid="stats-scope-notice"
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-primary-soft px-3.5 py-2.5"
          >
            <BarChart3
              aria-hidden="true"
              className="size-[15px] shrink-0 text-primary-text"
            />
            <span className="min-w-0 text-xs text-primary-text">
              {t("overview.stats.scopeNotice.text")}
            </span>
            <span className="flex-1" />
            <Link
              to={PRIVACY_SETTINGS_PATH}
              className="text-xs font-medium text-primary-text hover:underline"
            >
              {t("overview.stats.scopeNotice.action")}
            </Link>
          </div>
        ) : null}

        {freshAccount ? (
          <div
            data-testid="stats-new-account"
            className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-status-waiting/40 bg-status-waiting-bg px-3.5 py-2.5"
          >
            <Monitor
              aria-hidden="true"
              className="size-[15px] shrink-0 text-status-waiting"
            />
            <span className="min-w-0 text-xs text-status-waiting">
              {t("overview.stats.newAccount.text")}
            </span>
            <span className="flex-1" />
            <Button asChild size="xs">
              <Link to="/devices">{t("overview.stats.newAccount.action")}</Link>
            </Button>
          </div>
        ) : null}

        {statsError !== null ? (
          <>
            <Alert variant="destructive">
              <span className="flex min-w-0 flex-wrap items-center gap-3">
                <span className="min-w-0">{statsErrorMessage}</span>
                <span className="flex-1" />
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setReloadKey((k) => k + 1)}
                >
                  {t("overview.stats.error.retry")}
                </Button>
              </span>
            </Alert>
            {/* 统计取不到就说取不到，绝不退回一张全是 0 的摘要——那是一句用户
                无法证伪的假话。同时说清什么**不**受影响，并给一条走得通的路。 */}
            <div className="rounded-lg border border-border bg-card">
              <EmptyState
                testId="stats-error"
                icon={BarChart3}
                tone="warn"
                title={t("overview.stats.error.title")}
                body={t("overview.stats.error.body")}
                action={
                  <Link
                    to="/chat"
                    className="text-xs font-medium text-primary-text hover:underline"
                  >
                    {t("overview.stats.error.action")}
                  </Link>
                }
              />
            </div>
          </>
        ) : (
          <>
            {/* 摘要四格 */}
            <div
              data-testid="overview-tiles"
              className="grid grid-cols-2 gap-3 md:grid-cols-4"
            >
              {summary === undefined ? (
                <TileSkeletons />
              ) : (
                <>
                  <Metric
                    testId="tile-conversations"
                    label={t("overview.stats.tiles.conversations")}
                    value={String(summary.conversations)}
                    unit={rangeLabel}
                    sub={
                      freshAccount
                        ? t("overview.stats.tiles.conversationsNone")
                        : t("overview.stats.tiles.conversationsTotal", {
                            count: summary.conversations_total,
                          })
                    }
                    icon={MessagesSquare}
                  />
                  <Metric
                    testId="tile-streak"
                    label={t("overview.stats.tiles.streak")}
                    value={noHistory ? "—" : String(summary.streak_days)}
                    unit={
                      noHistory
                        ? undefined
                        : t("overview.stats.tiles.streakUnit")
                    }
                    sub={
                      noHistory
                        ? stats?.activity_stats_enabled
                          ? null
                          : t("overview.stats.tiles.enableToSee")
                        : t("overview.stats.tiles.streakLongest", {
                            count: summary.longest_streak_days,
                          })
                    }
                    icon={Flame}
                  />
                  <Metric
                    testId="tile-active-days"
                    label={t("overview.stats.tiles.activeDays")}
                    value={noHistory ? "—" : String(summary.active_days)}
                    unit={
                      noHistory || summary.window_days <= 0
                        ? undefined
                        : t("overview.stats.tiles.activeDaysUnit", {
                            count: summary.window_days,
                          })
                    }
                    sub={
                      noHistory
                        ? stats?.activity_stats_enabled
                          ? null
                          : t("overview.stats.tiles.enableToSee")
                        : summary.window_days > 0
                          ? t("overview.stats.tiles.activeDaysShare", {
                              percent: Math.round(
                                (summary.active_days / summary.window_days) *
                                  100,
                              ),
                            })
                          : null
                    }
                    icon={CalendarDays}
                  />
                  <Metric
                    testId="tile-online"
                    label={t("overview.stats.tiles.online")}
                    value={String(summary.devices_online)}
                    unit={`/ ${summary.devices_total}`}
                    sub={
                      firstOffline
                        ? t("overview.stats.tiles.onlineOffline", {
                            device: firstOffline.name,
                          })
                        : summary.devices_total === 0
                          ? t("overview.stats.tiles.onlineNone")
                          : null
                    }
                    icon={Monitor}
                  />
                </>
              )}
            </div>

            {/* 全宽活跃热力 */}
            <StatsCard
              testId="heatmap-card"
              title={t("overview.stats.heatmap.title")}
              action={
                <span className="flex min-w-0 items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {isMobile
                      ? t("overview.stats.heatmap.mobileWeeks")
                      : monthRange}
                  </span>
                  {/* scope 为 saved 时不再给这条链接：页顶那条说明条上已经有一条
                      「开启完整活跃统计 →」指向同一处，一屏两条同去处的链接只是
                      让人多读一遍。 */}
                  {stats?.scope === "saved" ? null : (
                    <Link
                      to={PRIVACY_SETTINGS_PATH}
                      className="text-xs font-medium text-primary-text hover:underline"
                    >
                      {t("overview.stats.heatmap.settings")}
                    </Link>
                  )}
                </span>
              }
            >
              <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
                <div className="flex min-w-0 flex-col gap-2.5">
                  {/* 取数前后是同一张网格，只是没有颜色——845px 的网格不该在取到数
                      那一刻凭空出现，把整页往下顶一大截。 */}
                  <Heatmap
                    to={stats?.heatmap.to ?? todayUTC()}
                    weeks={heatmapWeeks}
                    days={stats?.heatmap.days}
                  />
                  <HeatmapLegend />
                  {isMobile ? (
                    <p className="text-2xs text-muted-foreground">
                      {t("overview.stats.heatmap.mobileHint")}
                    </p>
                  ) : null}
                  {stats !== null && stats.heatmap.days.length === 0 ? (
                    <p className="text-2xs text-muted-foreground">
                      {t("overview.stats.heatmap.greyNote")}
                    </p>
                  ) : null}
                  {/* 日界按服务端机器的时区切，不是按浏览器的。不写出来的话，一个在
                      另一个时区的用户只会觉得自己的「今天」错了一格。 */}
                  {stats?.time_zone ? (
                    <p
                      data-testid="heatmap-timezone"
                      className="text-2xs text-muted-foreground"
                    >
                      {t("overview.stats.heatmap.timeZone", {
                        zone: stats.time_zone,
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-4 lg:w-[240px] lg:border-l lg:border-border lg:pl-5">
                  {stats?.heatmap.busiest_day &&
                  stats.heatmap.busiest_day.count > 0 ? (
                    <Highlight
                      testId="heat-highlight-busiest"
                      label={t("overview.stats.heatmap.busiest")}
                      value={t("overview.stats.unit.conversations", {
                        count: stats.heatmap.busiest_day.count,
                      })}
                      sub={stats.heatmap.busiest_day.day}
                    />
                  ) : null}
                  {stats?.heatmap.avg_per_active_day ? (
                    <Highlight
                      testId="heat-highlight-avg"
                      label={t("overview.stats.heatmap.avg")}
                      value={t("overview.stats.unit.conversations", {
                        count: stats.heatmap.avg_per_active_day,
                      })}
                      sub={t("overview.stats.heatmap.avgSub")}
                    />
                  ) : null}
                </div>
              </div>
            </StatsCard>

            {/* 底部：Agent 排行（左，占满）+ 右列 300 宽 */}
            <div
              data-testid="overview-cols"
              className="flex flex-col gap-4 lg:flex-row"
            >
              <StatsCard
                testId="card-agents"
                className="min-w-0 flex-1"
                title={t("overview.stats.agents.title")}
                meta={rangeLabel}
                action={
                  <Link
                    to="/org"
                    className="text-xs font-medium text-primary-text hover:underline"
                  >
                    {t("overview.stats.agents.all")}
                  </Link>
                }
              >
                {stats === null ? (
                  <CardSkeleton rows={5} />
                ) : stats.agents.length === 0 ? (
                  <EmptyState
                    testId="empty-agents"
                    icon={Bot}
                    title={t("overview.stats.agents.empty")}
                  />
                ) : (
                  <ol className="flex flex-col gap-3">
                    {stats.agents.map((row, index) => (
                      <AgentRankRow
                        key={row.sync_id || index}
                        row={row}
                        agent={agentsBySync.get(row.sync_id)}
                        max={stats.agents[0]?.count ?? row.count}
                      />
                    ))}
                  </ol>
                )}
              </StatsCard>

              <aside
                data-testid="overview-aside"
                className="flex w-full shrink-0 flex-col gap-4 lg:w-[300px]"
              >
                <StatsCard
                  testId="card-backends"
                  title={t("overview.stats.backends.title")}
                  meta={rangeLabel}
                >
                  {stats === null ? (
                    <CardSkeleton rows={4} />
                  ) : stats.backends.length === 0 &&
                    stats.models.length === 0 ? (
                    <EmptyState
                      testId="empty-backends"
                      icon={BarChart3}
                      title={t("overview.stats.backends.empty")}
                    />
                  ) : (
                    <BackendsBody
                      backends={stats.backends}
                      models={stats.models}
                    />
                  )}
                </StatsCard>

                <StatsCard
                  testId="card-projects"
                  title={t("overview.stats.projects.title")}
                  meta={rangeLabel}
                >
                  {stats === null ? (
                    <CardSkeleton rows={4} />
                  ) : stats.projects.length === 0 ? (
                    <EmptyState
                      testId="empty-projects"
                      icon={FolderTree}
                      title={t("overview.stats.projects.empty")}
                    />
                  ) : (
                    <ProjectsBody
                      rows={stats.projects}
                      nameOf={(syncId) => projectsBySync.get(syncId)?.name}
                    />
                  )}
                </StatsCard>
              </aside>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

/** 今天（UTC）的 `YYYY-MM-DD`：还没取到数时用它把骨架网格的右端钉住。 */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function Highlight({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-0.5">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="text-prose leading-none font-bold text-foreground">
        {value}
      </span>
      <span className="truncate text-2xs text-muted-foreground">{sub}</span>
    </div>
  );
}

/**
 * Agent 使用排行的一行。
 *
 * 「当前落到哪台」只在这一档**真的可用**时才画：一个说不出落到哪的落点标记，
 * 比不画更糟——它看上去像在保证下一条对话跑得起来。
 */
function AgentRankRow({
  row,
  agent,
  max,
}: {
  row: { sync_id: string; count: number };
  agent?: AgentItem;
  max: number;
}) {
  const current = agent?.exec_targets?.find((tt) => tt.current);
  const landing =
    agent?.has_available_target && current
      ? [
          current.is_local_reference ? null : current.device_name,
          current.backend_type
            ? orgBackendTypeLabel(current.backend_type)
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const color = agent?.avatar_color;

  return (
    <li
      data-testid="agent-rank-row"
      data-sync-id={row.sync_id}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            color ? undefined : "bg-primary",
          )}
          style={color ? { backgroundColor: color } : undefined}
        />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {agent?.name ?? row.sync_id}
        </span>
        {agent?.department_name ? (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            {agent.department_name}
          </span>
        ) : null}
        <span className="flex-1" />
        {landing ? (
          <span
            data-testid="agent-rank-target"
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5"
          >
            <span
              aria-hidden="true"
              className="size-[5px] rounded-full bg-status-running"
            />
            <span className="text-2xs text-muted-foreground">{landing}</span>
          </span>
        ) : null}
        <span className="shrink-0 text-xs font-semibold text-foreground">
          {row.count}
        </span>
      </div>
      <Bar
        ratio={max > 0 ? row.count / max : 0}
        className={color ? undefined : "bg-primary"}
        style={color ? { backgroundColor: color } : undefined}
      />
    </li>
  );
}

/**
 * 后端与模型。
 *
 * 两个「空」是两件不同的事，绝不能并成一行：
 *   - `backend_type` 为空 = 那条对话没上报后端（未上报）；
 *   - `provider_key` 与 `model_key` 皆空 = 跟随 Agent 绑定，是一档真实配置。
 */
function BackendsBody({
  backends,
  models,
}: {
  backends: { backend_type: string; count: number }[];
  models: { provider_key: string; model_key: string; count: number }[];
}) {
  const { t } = useTranslation();
  const total = backends.reduce((sum, b) => sum + b.count, 0);
  const toneOf = (backend: string, index: number) =>
    backend === ""
      ? "bg-status-idle"
      : BACKEND_TONES[index % BACKEND_TONES.length];
  const modelMax = models.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {total > 0 ? (
        <span className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
          {backends.map((b, i) => (
            <span
              key={b.backend_type || "unreported"}
              aria-hidden="true"
              className={cn("block h-full", toneOf(b.backend_type, i))}
              style={{ width: `${(b.count / total) * 100}%` }}
            />
          ))}
        </span>
      ) : null}
      <ul className="flex min-w-0 flex-col gap-1.5">
        {backends.map((b, i) => (
          <li
            key={b.backend_type || "unreported"}
            className="flex min-w-0 items-center gap-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-sm",
                toneOf(b.backend_type, i),
              )}
            />
            <span className="min-w-0 truncate text-xs text-foreground">
              {b.backend_type
                ? orgBackendTypeLabel(b.backend_type)
                : t("overview.stats.backends.unreported")}
            </span>
            <span className="flex-1" />
            <span className="shrink-0 text-2xs text-muted-foreground">
              {t("overview.stats.unit.conversations", { count: b.count })}
            </span>
            {total > 0 ? (
              <span className="w-9 shrink-0 text-right text-xs text-foreground">
                {`${Math.round((b.count / total) * 100)}%`}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {models.length > 0 ? (
        <>
          <span className="h-px w-full bg-border" />
          <span className="text-2xs text-muted-foreground">
            {t("overview.stats.backends.models")}
          </span>
          <ul className="flex min-w-0 flex-col gap-2">
            {models.map((m, i) => (
              <li
                key={
                  m.model_key
                    ? `${m.provider_key}/${m.model_key}`
                    : `follow-${i}`
                }
                className="flex min-w-0 items-center gap-2"
              >
                {m.model_key ? (
                  <span className="min-w-0 truncate font-mono text-2xs text-code-foreground">
                    {m.model_key}
                  </span>
                ) : (
                  // 「跟随 Agent 绑定」是翻译过的正文，不能上等宽——包里只自托管了
                  // 拉丁子集，中文会掉到下一档字体，一行两种字形。
                  <span className="min-w-0 truncate text-2xs text-muted-foreground">
                    {t("overview.stats.backends.followsAgent")}
                  </span>
                )}
                <span className="flex-1" />
                <span className="w-[90px] shrink-0">
                  <Bar
                    ratio={modelMax > 0 ? m.count / modelMax : 0}
                    className="bg-heat-3"
                  />
                </span>
                <span className="w-6 shrink-0 text-right text-xs text-foreground">
                  {m.count}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** 项目分布。空 `sync_id` = 未归属项目（cwd 两个方向都不出服务端，R19）。 */
function ProjectsBody({
  rows,
  nameOf,
}: {
  rows: { sync_id: string; count: number }[];
  nameOf: (syncId: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <ul className="flex min-w-0 flex-col gap-2.5">
      {rows.map((row, index) => (
        <li
          key={row.sync_id || "unassigned"}
          className="flex min-w-0 flex-col gap-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-xs",
                row.sync_id ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {row.sync_id
                ? (nameOf(row.sync_id) ?? row.sync_id)
                : t("overview.stats.projects.unassigned")}
            </span>
            <span className="flex-1" />
            <span className="shrink-0 text-2xs text-muted-foreground">
              {t("overview.stats.unit.conversations", { count: row.count })}
            </span>
          </div>
          <Bar
            ratio={max > 0 ? row.count / max : 0}
            className={rankHeat(index)}
          />
        </li>
      ))}
    </ul>
  );
}
