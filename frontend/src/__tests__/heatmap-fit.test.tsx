import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEATMAP_DESKTOP_WEEKS,
  HEATMAP_MOBILE_WEEKS,
  Heatmap,
  heatmapColumnsFor,
  useHeatmapWeeks,
} from "@/components/stats/Heatmap";
import i18n from "@/i18n";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

/** 与 session-detail-mobile.test.tsx 同一个桩：把 matchMedia 改答成移动视口。 */
function mockMobileViewport() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

/**
 * 列数跟着**容器量到的宽度**走。
 *
 * 此前它跟着 `useIsMobile`（≤767px）走，于是 768–1511 的每一档桌面视口都在画一张
 * 比左列宽的网格：格子是 `shrink-0`，多出来的部分直接画在右列的分割线和「最活跃的
 * 一天」上（1280 上量到 160px），<1024 时冲出卡片被外壳的 overflow-hidden 裁掉。
 * 视口宽根本不是这笔账的输入——侧栏收起、右列在不在、容器封顶都会改左列的宽度。
 */
function WeeksProbe({ width }: { width: number }) {
  const { ref, weeks } = useHeatmapWeeks();
  return (
    <div
      data-testid="probe"
      ref={(node) => {
        // jsdom 没有布局，clientWidth 恒为 0；把真机上量到的那个值摆进去。
        if (node)
          Object.defineProperty(node, "clientWidth", {
            value: width,
            configurable: true,
          });
        ref(node);
      }}
    >
      {weeks}
    </div>
  );
}

describe("useHeatmapWeeks", () => {
  it("量到多宽就画几列：1280 上左列 702px 那一档不再溢出", () => {
    render(<WeeksProbe width={702} />);
    expect(screen.getByTestId("probe").textContent).toBe(
      String(heatmapColumnsFor(702)),
    );
    expect(heatmapColumnsFor(702)).toBeLessThan(HEATMAP_DESKTOP_WEEKS);
  });

  it("宽得下一整年就给满 53 列", () => {
    render(<WeeksProbe width={878} />);
    expect(screen.getByTestId("probe").textContent).toBe(
      String(HEATMAP_DESKTOP_WEEKS),
    );
  });

  it("量不到宽度时退回窄屏那一档，而不是画 0 列", () => {
    render(<WeeksProbe width={0} />);
    expect(screen.getByTestId("probe").textContent).toBe(
      String(HEATMAP_MOBILE_WEEKS),
    );
  });
});

/**
 * 悬停读数。
 *
 * 原来靠原生 `title`：要停一秒才出，出来的是系统气泡，深色下是一块白，而且触屏上
 * 永远看不到。换成图里自己的浮层，鼠标一进就出。
 */
describe("热力图的悬停读数", () => {
  const days = [
    { day: "2026-08-28", count: 12 },
    { day: "2026-08-24", count: 3 },
  ];

  function cellOf(day: string): HTMLElement {
    const cell = document.querySelector(`[data-day="${day}"]`);
    expect(cell).not.toBeNull();
    return cell as HTMLElement;
  }

  it("鼠标进到一格就报出那天的日期与条数", () => {
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    expect(screen.queryByTestId("heat-tooltip")).toBeNull();

    fireEvent.mouseEnter(cellOf("2026-08-28"));
    const tip = screen.getByTestId("heat-tooltip");
    expect(tip.textContent).toContain("12 conversations");
    expect(tip.textContent).toContain("Aug 28, 2026");
  });

  it("换一格就换一份读数，离开网格就收起来", () => {
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);

    fireEvent.mouseEnter(cellOf("2026-08-28"));
    fireEvent.mouseEnter(cellOf("2026-08-24"));
    expect(screen.getByTestId("heat-tooltip").textContent).toContain(
      "3 conversations",
    );

    fireEvent.mouseLeave(screen.getByTestId("heat-cells"));
    expect(screen.queryByTestId("heat-tooltip")).toBeNull();
  });

  it("还没到的那天没有读数：空格子不报「0 条」", () => {
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    // 2026-08-28 是周五，同一列的周六是 to 之后的空格。
    const blanks = screen
      .getAllByTestId("heat-cell")
      .filter((c) => !c.hasAttribute("data-day"));
    expect(blanks.length).toBeGreaterThan(0);
    fireEvent.mouseEnter(blanks[0]);
    expect(screen.queryByTestId("heat-tooltip")).toBeNull();
  });

  /**
   * 读数是从网格里现读的，不是 mouseenter 那一刻抄进 state 的。
   *
   * 抄一份的那一版在本地代理上一测就露馅（2026-09-03）：鼠标停在一格上不动、
   * 统计这时才落地，浮层一直报着骨架期的「0 条」——鼠标不动就没有第二次
   * mouseenter，那份抄件永远不会被换掉。
   */
  it("鼠标不动而数据后到：读数跟着新数据走，不停在骨架期的 0 条", () => {
    const { rerender } = render(<Heatmap to="2026-08-28" weeks={5} />);
    fireEvent.mouseEnter(cellOf("2026-08-28"));
    expect(screen.getByTestId("heat-tooltip").textContent).toContain(
      "0 conversations",
    );

    rerender(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    expect(screen.getByTestId("heat-tooltip").textContent).toContain(
      "12 conversations",
    );
  });

  it("不再挂原生 title：两层气泡会一起冒出来", () => {
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    expect(cellOf("2026-08-28").hasAttribute("title")).toBe(false);
  });
});

/**
 * 移动端点按读数：手指会挡住浮层，固定行不遮挡格子（设计决策 8）。
 *
 * 只在 isMobile 时生效——desktop 悬停行为不变，验证方式是这一整块桩前后
 * 桌面视口那些既有用例（上面的「热力图的悬停读数」）不受影响。
 */
describe("热力图的点按读数（移动端）", () => {
  const realMatchMedia = window.matchMedia;
  const days = [
    { day: "2026-08-28", count: 12 },
    { day: "2026-08-24", count: 0 },
  ];

  function cellOf(day: string): HTMLElement {
    const cell = document.querySelector(`[data-day="${day}"]`);
    expect(cell).not.toBeNull();
    return cell as HTMLElement;
  }

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it("未点任何格子时，固定行提示「点一格看当天」", () => {
    mockMobileViewport();
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    expect(screen.getByTestId("heatmap-readout").textContent).toBe(
      "Tap a cell to see that day",
    );
  });

  it("点一格（2026-08-28 是周五，12 个对话）：读数换成日期 + 星期 + 条数", () => {
    mockMobileViewport();
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    fireEvent.click(cellOf("2026-08-28"));
    expect(screen.getByTestId("heatmap-readout").textContent).toBe(
      "Aug 28, 2026 (Fri) · 12 conversations",
    );
  });

  it("那天是 0 条：读数说「没有对话」而不是「0 conversations」", () => {
    mockMobileViewport();
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    fireEvent.click(cellOf("2026-08-24"));
    expect(screen.getByTestId("heatmap-readout").textContent).toBe(
      "Aug 24, 2026 (Mon) · No conversations",
    );
  });

  it("中文界面：读数说「N 个对话」（规格原文），而不是统计卡的量词「N 条」", async () => {
    await i18n.changeLanguage("zh-CN");
    mockMobileViewport();
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    fireEvent.click(cellOf("2026-08-28"));
    const text = screen.getByTestId("heatmap-readout").textContent ?? "";
    expect(text).toContain("（周五）");
    expect(text.endsWith(" · 12 个对话")).toBe(true);
  });

  it("英文单数：1 天 1 个对话读作「1 conversation」", () => {
    mockMobileViewport();
    render(
      <Heatmap
        to="2026-08-28"
        weeks={5}
        days={[{ day: "2026-08-28", count: 1 }]}
      />,
    );
    fireEvent.click(cellOf("2026-08-28"));
    expect(screen.getByTestId("heatmap-readout").textContent).toBe(
      "Aug 28, 2026 (Fri) · 1 conversation",
    );
  });

  it("网格换列数（转屏改宽）后：读数与描边仍跟着点的那一天，而不是同一坐标上的另一天", () => {
    mockMobileViewport();
    const { rerender } = render(
      <Heatmap to="2026-08-28" weeks={5} days={days} />,
    );
    fireEvent.click(cellOf("2026-08-28"));

    rerender(<Heatmap to="2026-08-28" weeks={6} days={days} />);

    expect(screen.getByTestId("heatmap-readout").textContent).toBe(
      "Aug 28, 2026 (Fri) · 12 conversations",
    );
    expect(cellOf("2026-08-28").className).toContain("ring-primary");
    expect(
      document.querySelectorAll(
        '[data-testid="heat-cell"][class*="ring-primary"]',
      ),
    ).toHaveLength(1);
  });

  it("点过的那天滚出网格（换了截止日）：读数回到提示，不报别的日子", () => {
    mockMobileViewport();
    const { rerender } = render(
      <Heatmap to="2026-08-28" weeks={5} days={days} />,
    );
    fireEvent.click(cellOf("2026-08-24"));

    rerender(<Heatmap to="2026-10-30" weeks={5} days={days} />);

    expect(screen.getByTestId("heatmap-readout").textContent).toBe(
      "Tap a cell to see that day",
    );
  });

  it("被点的格子有选中描边，其余格子没有", () => {
    mockMobileViewport();
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    const target = cellOf("2026-08-28");
    const other = cellOf("2026-08-24");
    fireEvent.click(target);
    expect(target.className).toContain("ring-primary");
    expect(other.className).not.toContain("ring-primary");
  });

  it("今天之后的格子不可点：没有 onClick，点了也不改读数", () => {
    mockMobileViewport();
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    // 2026-08-28 是周五，同一列的周六（2026-08-29）是 to 之后的空格。
    const blanks = screen
      .getAllByTestId("heat-cell")
      .filter((c) => !c.hasAttribute("data-day"));
    expect(blanks.length).toBeGreaterThan(0);
    fireEvent.click(blanks[0]);
    expect(screen.getByTestId("heatmap-readout").textContent).toBe(
      "Tap a cell to see that day",
    );
  });

  it("桌面视口：不画固定读数行，点格子也不加选中描边", () => {
    render(<Heatmap to="2026-08-28" weeks={5} days={days} />);
    expect(screen.queryByTestId("heatmap-readout")).toBeNull();
    const cell = cellOf("2026-08-28");
    fireEvent.click(cell);
    expect(cell.className).not.toContain("ring-primary");
  });
});
