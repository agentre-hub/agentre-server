/**
 * GitHub 式活跃热力格子图的纯计算。
 *
 * 抽出来的理由是这一块的错法**全都不出声**：多画一列、把周三画进周二那一行、
 * 或者把「今天之后」的空格子涂成 heat-0（等于对着还没到的日子说「那天没干活」），
 * 在 jsdom 里都是绿的。日期算术留在这里，组件那边只剩「一格一个 div」。
 *
 * 全程按 UTC 解析 `YYYY-MM-DD`：服务端已经按它自己的时区分好桶了（口径见
 * docs 的统计说明），日界在这里再按浏览器本地时区解析一次，只会让 UTC+8 之外的
 * 用户整张图错开一天。
 */

/** 服务端给的一天：`GET /v1/stats/overview` 的 `heatmap.days` 一项。 */
export interface HeatDay {
  day: string;
  count: number;
}

/** 五级色阶的档位；0 = 那天没有活动（不是「没有数据」）。 */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  /** `YYYY-MM-DD`；**null = 这一格落在 to 之后，不画**。 */
  day: string | null;
  count: number;
  level: HeatLevel;
}

export interface HeatMonthLabel {
  /** 这个标签挂在第几列（0 起）。 */
  column: number;
  /** 0–11，交给调用方用 Intl 本地化——月份名不进 locale 文件。 */
  month: number;
  year: number;
}

export interface HeatGrid {
  /** 每一项是一列（一周），列内 7 格，行 0 是周日。 */
  weeks: HeatCell[][];
  months: HeatMonthLabel[];
  /** 网格范围内单日的最大条数；0 = 这一年一条都没有。 */
  max: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` → UTC 时间戳。解不动时返回 NaN，由调用方兜底到今天。 */
function parseDay(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC 时间戳 → `YYYY-MM-DD`。 */
function formatDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * 一天的色阶档位。
 *
 * `count > 0` 一律至少落到 1：活动了一次的那天必须与「什么都没干」在视觉上分得开，
 * 否则一个低活跃的账号整张图是灰的，看上去像坏了。
 */
export function heatLevel(count: number, max: number): HeatLevel {
  if (count <= 0 || max <= 0) return 0;
  const step = Math.ceil((count / max) * 4);
  return Math.min(4, Math.max(1, step)) as HeatLevel;
}

/**
 * 铺一张 `weeks` 列宽、以 `to` 那天所在的周收尾的网格。
 *
 * `days` 省略即整张网格都是 0 —— 骨架态就是这么来的：先按空格子铺满，取到数再
 * 上色，免得 845px 的网格在页面上凭空出现一次。
 */
export function buildHeatGrid({
  to,
  weeks,
  days,
}: {
  to: string;
  weeks: number;
  days?: HeatDay[];
}): HeatGrid {
  const endRaw = parseDay(to);
  const end = Number.isNaN(endRaw) ? parseDay(formatDay(Date.now())) : endRaw;
  // 最后一列的周日。getUTCDay() 里 0 就是周日，所以直接减掉即可。
  const lastSunday = end - new Date(end).getUTCDay() * DAY_MS;
  const firstSunday = lastSunday - (weeks - 1) * 7 * DAY_MS;

  const counts = new Map<string, number>();
  for (const d of days ?? []) {
    if (typeof d?.day !== "string") continue;
    counts.set(d.day, (counts.get(d.day) ?? 0) + (d.count ?? 0));
  }

  // 先按格子取一遍真实条数，再定 max —— 拿服务端整段的最大值（可能落在网格外，
  // 窄屏只画 19 周时一定会）当分母，会让本屏最活跃的那天也只有二档色。
  const raw: { day: string | null; count: number }[][] = [];
  let max = 0;
  for (let c = 0; c < weeks; c++) {
    const col: { day: string | null; count: number }[] = [];
    for (let r = 0; r < 7; r++) {
      const ts = firstSunday + (c * 7 + r) * DAY_MS;
      if (ts > end) {
        col.push({ day: null, count: 0 });
        continue;
      }
      const day = formatDay(ts);
      const count = counts.get(day) ?? 0;
      if (count > max) max = count;
      col.push({ day, count });
    }
    raw.push(col);
  }

  const grid: HeatCell[][] = raw.map((col) =>
    col.map((cell) => ({
      ...cell,
      level: cell.day === null ? 0 : heatLevel(cell.count, max),
    })),
  );

  const months: HeatMonthLabel[] = [];
  for (let c = 0; c < weeks; c++) {
    const ts = firstSunday + c * 7 * DAY_MS;
    const d = new Date(ts);
    const month = d.getUTCMonth();
    const year = d.getUTCFullYear();
    const prev = months.at(-1);
    // 第一列永远带标签，否则最左边那一段没有月份可读。
    if (!prev || prev.month !== month || prev.year !== year) {
      months.push({ column: c, month, year });
    }
  }

  return { weeks: grid, months, max };
}
