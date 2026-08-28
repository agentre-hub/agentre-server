import { describe, expect, it } from "vitest";

import { buildHeatGrid, type HeatDay } from "@/lib/heatmap";

/**
 * 热力网格的纯计算。
 *
 * 抽成纯函数的理由不是「好测」，是这一块的错法全都不出声：多画一列、把周三画到
 * 周二那一行、把「今天之后」的空格子涂成 heat-0（= 对着未来说「那天没干活」），
 * 在 jsdom 里全是绿的，只有肉眼在真页面上才看得出来。
 */
describe("buildHeatGrid", () => {
  const days: HeatDay[] = [
    { day: "2026-08-28", count: 11 },
    { day: "2026-08-24", count: 3 },
    { day: "2026-08-10", count: 1 },
  ];

  it("按周分列、行 0 是周日，最后一列含 to 那天", () => {
    // 2026-08-28 是周五。
    const grid = buildHeatGrid({ to: "2026-08-28", weeks: 5, days });
    expect(grid.weeks.length).toBe(5);
    for (const col of grid.weeks) expect(col.length).toBe(7);

    const last = grid.weeks[4];
    // 那一周的周日是 08-23，周五是 08-28。
    expect(last[0].day).toBe("2026-08-23");
    expect(last[5].day).toBe("2026-08-28");
    expect(last[5].count).toBe(11);
    expect(last[1].day).toBe("2026-08-24");
    expect(last[1].count).toBe(3);
  });

  it("to 之后的格子不画：day 为 null，而不是一个 count=0 的格", () => {
    // 画成 heat-0 的空格子等于说「那天没有活动」，而那天还没到。
    const grid = buildHeatGrid({ to: "2026-08-28", weeks: 5, days });
    const last = grid.weeks[4];
    expect(last[6].day).toBeNull();
    expect(last[6].level).toBe(0);
    // to 那天本身照常画。
    expect(last[5].day).toBe("2026-08-28");
  });

  it("没上榜的那天是真实的 0 条，level 0", () => {
    const grid = buildHeatGrid({ to: "2026-08-28", weeks: 5, days });
    const cell = grid.weeks[4][2];
    expect(cell.day).toBe("2026-08-25");
    expect(cell.count).toBe(0);
    expect(cell.level).toBe(0);
  });

  it("色阶按网格里的最大值分四档，最大的那天落在 4", () => {
    const grid = buildHeatGrid({
      to: "2026-08-28",
      weeks: 5,
      days: [
        { day: "2026-08-28", count: 12 },
        { day: "2026-08-27", count: 9 },
        { day: "2026-08-26", count: 6 },
        { day: "2026-08-25", count: 3 },
        { day: "2026-08-24", count: 1 },
      ],
    });
    const byDay = new Map(
      grid.weeks.flat().map((c) => [c.day, c.level] as const),
    );
    expect(grid.max).toBe(12);
    expect(byDay.get("2026-08-28")).toBe(4);
    expect(byDay.get("2026-08-27")).toBe(3);
    expect(byDay.get("2026-08-26")).toBe(2);
    expect(byDay.get("2026-08-25")).toBe(1);
    // 1 条也是有活动的一天：绝不能因为凑不满一档而退回 heat-0。
    expect(byDay.get("2026-08-24")).toBe(1);
  });

  it("一条数据都没有时仍然铺满整张网格（骨架就靠它）", () => {
    const grid = buildHeatGrid({ to: "2026-08-28", weeks: 19 });
    expect(grid.weeks.length).toBe(19);
    expect(grid.max).toBe(0);
    expect(grid.weeks.flat().every((c) => c.level === 0)).toBe(true);
    // 铺满 ≠ 把未来涂上：最后一列仍有不画的格。
    expect(grid.weeks[18][6].day).toBeNull();
  });

  it("月份标签只在换月那一列出现，且给出的是那一列的年月", () => {
    const grid = buildHeatGrid({ to: "2026-08-28", weeks: 10 });
    expect(grid.months.length).toBeGreaterThanOrEqual(2);
    // 第一列永远带一个标签，否则最左边那一段没有月份可读。
    expect(grid.months[0].column).toBe(0);
    for (let i = 1; i < grid.months.length; i++) {
      expect(grid.months[i].column).toBeGreaterThan(grid.months[i - 1].column);
      expect(grid.months[i].month).not.toBe(grid.months[i - 1].month);
    }
    expect(grid.months.at(-1)?.month).toBe(7); // 8 月 = 索引 7
    expect(grid.months.at(-1)?.year).toBe(2026);
  });

  it("跨年不塌：12 月与次年 1 月各自成段", () => {
    const grid = buildHeatGrid({ to: "2026-01-15", weeks: 8 });
    const labels = grid.months.map((m) => `${m.year}-${m.month}`);
    expect(labels).toContain("2025-11");
    expect(labels).toContain("2026-0");
  });
});
