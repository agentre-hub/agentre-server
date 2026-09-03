import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@agentre-hub/agentre-ui";

import { buildHeatGrid, type HeatDay, type HeatLevel } from "@/lib/heatmap";

/** 一年 = 53 列，13px 格 + 3px 缝隙 = 845px 网格。列数的上限，不是默认值。 */
export const HEATMAP_DESKTOP_WEEKS = 53;
/**
 * 还量不到容器宽度时的兜底列数。
 *
 * 53 周要 845px，390 宽放不下；也**不做横向滚动**——手机上横滚的热力图没法用，
 * 一屏永远只看得到一小段，还会把整页的纵向滚动抢走。更长的历史引导去桌面端。
 *
 * 这个数由 `heatmapWidthPx` 与 `MOBILE_CARD_CONTENT_PX` 定死（守卫见
 * heatmap-grid.test.ts）：此前写的 19 是拿视口宽算的，漏了网格左边那条星期栏，
 * 19 列连星期栏要 334px，比 390 手机上的卡片内容区宽 10px——最后那一列（今天）
 * 压在卡片边上（2026-08-31 在真机宽度下量到）。它同时是**最窄那一档也放得下**的
 * 列数，所以「还不知道有多宽」退回它是安全的。
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

/** 整张网格实际占的宽（含星期栏）。列数按它定。 */
export function heatmapWidthPx(weeks: number): number {
  return WEEKDAY_GUTTER_PX + weeks * COLUMN_PITCH - CELL_GAP_PX;
}

/**
 * `available` 这么宽的地方放得下几列。
 *
 * 列数**不能**按视口断点挑。左列拿到的宽度还要减掉侧栏（展开 224 / 收起 56）、
 * 页面的 `md:px-8`、卡片的 `px-4`，以及 lg 之后右边那一栏的 240 + 分隔线，外面
 * 还有个 `max-w-[1200px]` 封顶——53 列的 878px 要到视口 ~1512 才凑得出。此前它
 * 只问了 `useIsMobile`（≤767px），于是 768 到 1511 的每一档都在画一张比左列宽的
 * 网格：格子是 `shrink-0`，多出来的部分直接压在分割线和「最活跃的一天」上
 * （2026-09-03 在真浏览器上量到 1280 溢出 160px、1440 正好顶到分割线），<1024
 * 时更是冲出卡片被外壳的 overflow-hidden 裁掉。
 *
 * `available <= 0` 是「还没量到」（提交阶段之前、jsdom 里没有布局），不是
 * 「一列都放不下」：退回窄屏那一档，它在最窄的一档上也放得下。
 */
export function heatmapColumnsFor(available: number): number {
  if (available <= 0) return HEATMAP_MOBILE_WEEKS;
  const fit = Math.floor(
    (available - WEEKDAY_GUTTER_PX + CELL_GAP_PX) / COLUMN_PITCH,
  );
  return Math.max(1, Math.min(HEATMAP_DESKTOP_WEEKS, fit));
}

/**
 * 把 `ref` 挂到「网格能占多宽」由谁说了算的那个盒子上，拿回该画几列。
 *
 * 量的是容器而不是视口：侧栏收起 / 展开、右边那一栏在不在、容器封顶都会改这个宽度，
 * 而它们一个都不体现在视口宽上。
 *
 * 回调 ref 跑在提交阶段，所以第一次测量定下的列数在这一帧就绘出来，不会先闪一张
 * 兜底宽度的网格再跳成正确的；`ResizeObserver` 接住之后的每一次改宽。收敛是稳的：
 * 列数只会让网格变窄，而容器的宽度由外面的布局给定，不由网格反推。
 */
export function useHeatmapWeeks(): {
  ref: (node: HTMLElement | null) => void;
  weeks: number;
} {
  const [weeks, setWeeks] = useState(HEATMAP_MOBILE_WEEKS);
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    setWeeks(heatmapColumnsFor(node.clientWidth));
    const observer = new ResizeObserver(() => {
      setWeeks(heatmapColumnsFor(node.clientWidth));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  return { ref, weeks };
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
 * 鼠标停在哪一格。
 *
 * 只存坐标，**不存那天的日期与条数**：日期和条数从网格里现读。第一版把它们一起
 * 存进了 state，于是「鼠标停着不动、数据这时才落地」会让浮层一直报着骨架期的
 * 0 条——本地代理上一测就撞到了（2026-09-03）。同一维数据存两处，迟早有一处过期。
 */
interface HoverCell {
  column: number;
  row: number;
}

/**
 * 悬停读数。
 *
 * 位置全部由列/行号算出来——格子的尺寸是这个文件里的常量，没有必要（也不该）在
 * 渲染期去读真实布局。
 *
 * 三种贴法而不是一律居中：居中的浮层在第一列会伸到星期栏左边、在最后一列会伸出
 * 网格右缘，而 <1024 时网格右缘就贴着卡片边。头尾各三列改成与那一列对齐，中间照旧
 * 居中——不需要知道浮层自己有多宽，也就不必去量它。
 */
function HeatTooltip({
  hover,
  weeks,
  text,
}: {
  hover: HoverCell;
  weeks: number;
  text: string;
}) {
  const cellLeft = WEEKDAY_GUTTER_PX + hover.column * COLUMN_PITCH;
  const nearStart = hover.column <= 2;
  const nearEnd = hover.column >= weeks - 3;
  // 往上冒 6px，落在格子上边缘之上。
  const top = hover.row * COLUMN_PITCH - 6;
  return (
    <span
      data-testid="heat-tooltip"
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-10 -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-2xs whitespace-nowrap text-popover-foreground shadow-md",
        !nearStart && !nearEnd && "-translate-x-1/2",
      )}
      style={
        nearEnd
          ? { right: heatmapWidthPx(weeks) - (cellLeft + CELL_PX), top }
          : { left: nearStart ? cellLeft : cellLeft + CELL_PX / 2, top }
      }
    >
      {text}
    </span>
  );
}

/**
 * GitHub 式活跃热力格子图。
 *
 * `days` 省略即骨架：网格照常按 heat-0 铺满，取到数再上色。这不是为了好看——
 * 845px 的网格在取数完成那一刻凭空出现会把整页往下顶一大截，而骨架期间的页面
 * 高度本来就该和最终一致。
 *
 * `weeks` 由 `useHeatmapWeeks` 按容器实测宽度给出，调用方把那只 ref 挂在决定
 * 「网格能占多宽」的盒子上。
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

  const dayLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
      dateStyle: "medium",
      timeZone: "UTC",
    });
    return (day: string) => fmt.format(new Date(`${day}T00:00:00Z`));
  }, [i18n.resolvedLanguage]);

  const [hover, setHover] = useState<HoverCell | null>(null);
  /**
   * 鼠标停的那一格，从网格里现读。列数一变（改宽了）旧坐标可能已经不在网格里，
   * 这里读到 undefined 就不画浮层——不去猜一格。`day === null` 是「那天还没到」，
   * 同样不报：给未来报一句「0 条」比不报更糟。
   */
  const hoveredCell = hover ? grid.weeks[hover.column]?.[hover.row] : undefined;

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

      <div
        data-testid="heat-cells"
        // relative 是浮层的定位原点：读数按列/行号算位置，不去读任何盒子的
        // getBoundingClientRect（渲染期读布局是不纯的，而且滚动一下就过期）。
        className="relative flex gap-[3px]"
        onMouseLeave={() => setHover(null)}
      >
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
                  onMouseEnter={() => setHover({ column: index, row })}
                  className={cn(CELL_CLASS, LEVEL_CLASS[cell.level])}
                />
              ),
            )}
          </div>
        ))}
        {hover && hoveredCell?.day ? (
          <HeatTooltip
            hover={hover}
            weeks={weeks}
            text={`${dayLabel(hoveredCell.day)} · ${t("overview.stats.unit.conversations", { count: hoveredCell.count })}`}
          />
        ) : null}
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
