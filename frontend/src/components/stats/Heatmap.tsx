import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@agentre-hub/agentre-ui";

import { buildHeatGrid, type HeatDay, type HeatLevel } from "@/lib/heatmap";

/** 一年 = 53 列，13px 格 + 3px 缝隙 = 845px 网格。桌面端的卡刚好放得下。 */
export const HEATMAP_DESKTOP_WEEKS = 53;
/**
 * 窄屏只出近 18 周。
 *
 * 53 周要 845px，390 宽放不下；也**不做横向滚动**——手机上横滚的热力图没法用，
 * 一屏永远只看得到一小段，还会把整页的纵向滚动抢走。更长的历史引导去桌面端。
 *
 * 这个数由 `heatmapWidthPx` 与 `MOBILE_CARD_CONTENT_PX` 定死（守卫见
 * heatmap-grid.test.ts）：此前写的 19 是拿视口宽算的，漏了网格左边那条星期栏，
 * 19 列连星期栏要 334px，比 390 手机上的卡片内容区宽 10px——最后那一列（今天）
 * 压在卡片边上（2026-08-31 在真机宽度下量到）。
 */
export const HEATMAP_MOBILE_WEEKS = 18;

/** 格子边长与缝隙。与下面 CELL_CLASS / `gap-[3px]` 是同一组数，改一处要改另一处。 */
const CELL_PX = 13;
const CELL_GAP_PX = 3;
/**
 * 星期栏吃掉的宽：`w-6` (24) + `mr-1.5` (6) + 网格行的一个缝隙 (3)。
 * 它在网格左边，任何「放不放得下」的账都要算上它。
 */
const WEEKDAY_GUTTER_PX = 24 + 6 + CELL_GAP_PX;

/**
 * 窄屏的宽度预算：390 的视口 − main 的 `px-4` (32) − 卡片的 `px-4` 与边框 (34)
 * = 324px。390 是文档里点名支持的最窄一档（docs/design.md#responsive）。
 */
export const MOBILE_CARD_CONTENT_PX = 324;

/** 整张网格实际占的宽（含星期栏）。窄屏列数按它定。 */
export function heatmapWidthPx(weeks: number): number {
  return WEEKDAY_GUTTER_PX + weeks * COLUMN_PITCH - CELL_GAP_PX;
}

/** 五档色阶的类名。索引就是档位，heat-0 = 那天没有活动（可见的浅灰，不是透明）。 */
const LEVEL_CLASS: Record<HeatLevel, string> = {
  0: "bg-heat-0",
  1: "bg-heat-1",
  2: "bg-heat-2",
  3: "bg-heat-3",
  4: "bg-heat-4",
};

const CELL_CLASS = "size-[13px] shrink-0 rounded-[2px]";
/** 一列的步距：13px 格 + 3px 缝隙。月份标签按它定位。 */
const COLUMN_PITCH = CELL_PX + CELL_GAP_PX;

/**
 * GitHub 式活跃热力格子图。
 *
 * `days` 省略即骨架：网格照常按 heat-0 铺满，取到数再上色。这不是为了好看——
 * 845px 的网格在取数完成那一刻凭空出现会把整页往下顶一大截，而骨架期间的页面
 * 高度本来就该和最终一致。
 */
export function Heatmap({
  to,
  weeks,
  days,
  className,
}: {
  /** 最后一格是哪天（`YYYY-MM-DD`）。 */
  to: string;
  weeks: number;
  /** 省略 = 还没取到数，整张网格按 heat-0 铺满。 */
  days?: HeatDay[];
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const grid = useMemo(
    () => buildHeatGrid({ to, weeks, days }),
    [to, weeks, days],
  );

  // 月份名不进 locale 文件：Intl 已经按 resolvedLanguage 给得出来，抄一份十二个
  // 月的表进两份 json 只会多出一处要同步的东西。
  const monthName = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
      month: "short",
      timeZone: "UTC",
    });
    return (year: number, month: number) =>
      fmt.format(new Date(Date.UTC(year, month, 1)));
  }, [i18n.resolvedLanguage]);

  const dayTitle = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
      dateStyle: "medium",
      timeZone: "UTC",
    });
    return (day: string, count: number) =>
      `${fmt.format(new Date(`${day}T00:00:00Z`))} · ${count}`;
  }, [i18n.resolvedLanguage]);

  const weekdayRows: Record<number, string> = {
    1: t("overview.stats.heatmap.weekday.mon"),
    3: t("overview.stats.heatmap.weekday.wed"),
    5: t("overview.stats.heatmap.weekday.fri"),
  };

  return (
    <div
      data-testid="heatmap-grid"
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
    >
      {/* 月份标签绝对定位在列步距上。用一行等宽槽位放不下——"Sep" 比 13px 宽，
          会把整行撑开、和下面的网格错位。 */}
      <div
        className="relative h-[15px] shrink-0"
        style={{ marginLeft: COLUMN_PITCH + 12 }}
      >
        {grid.months.map((m) => (
          <span
            key={`${m.year}-${m.month}`}
            className="absolute top-0 text-2xs whitespace-nowrap text-muted-foreground"
            style={{ left: m.column * COLUMN_PITCH }}
          >
            {monthName(m.year, m.month)}
          </span>
        ))}
      </div>

      <div className="flex gap-[3px]">
        {/* 星期几只标一 / 三 / 五：七行全标会把这一列撑到比网格还高。 */}
        <div className="mr-1.5 flex shrink-0 flex-col gap-[3px]">
          {Array.from({ length: 7 }, (_, row) => (
            <span
              key={row}
              aria-hidden="true"
              className="h-[13px] w-6 text-3xs leading-[13px] text-muted-foreground"
            >
              {weekdayRows[row] ?? ""}
            </span>
          ))}
        </div>
        {grid.weeks.map((column, index) => (
          <div
            key={index}
            data-testid="heat-week"
            className="flex shrink-0 flex-col gap-[3px]"
          >
            {column.map((cell, row) =>
              cell.day === null ? (
                // to 之后的日子不画。留一个等大的空位是为了让最后一列不塌，
                // 但绝不给它底色——涂成 heat-0 等于对还没到的那天说「没干活」。
                <span
                  key={row}
                  aria-hidden="true"
                  data-testid="heat-cell"
                  data-level="0"
                  className={CELL_CLASS}
                />
              ) : (
                <span
                  key={row}
                  data-testid="heat-cell"
                  data-day={cell.day}
                  data-level={String(cell.level)}
                  title={dayTitle(cell.day, cell.count)}
                  className={cn(CELL_CLASS, LEVEL_CLASS[cell.level])}
                />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 五档色阶的图例。更少 → 更多。 */
export function HeatmapLegend({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="heat-legend"
      className={cn("flex items-center gap-1.5", className)}
    >
      <span className="text-2xs text-muted-foreground">
        {t("overview.stats.heatmap.less")}
      </span>
      {([0, 1, 2, 3, 4] as HeatLevel[]).map((level) => (
        <span
          key={level}
          data-testid="heat-legend-swatch"
          data-level={String(level)}
          aria-hidden="true"
          className={cn("size-[11px] rounded-[2px]", LEVEL_CLASS[level])}
        />
      ))}
      <span className="text-2xs text-muted-foreground">
        {t("overview.stats.heatmap.more")}
      </span>
    </div>
  );
}
