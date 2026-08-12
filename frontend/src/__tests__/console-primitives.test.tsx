/**
 * 共享控制台基础组件（task 1，正式 Pencil 组件 ZC7pI/A6Z3k/zF5jv/rNQXR/
 * IhldU 统计卡提炼）。
 *
 * 这些组件是全轮共享视觉基础：后续页面只消费其 API，不允许复制其尺寸、
 * 状态颜色、字阶或交互语义。本测试固定：
 *   - 尺寸：NavItem h-[34px]、TabBar h-[74px]、FilterChip h-[22px]、
 *     StatusMark 圆角胶囊、Metric value text-[23px]、EmptyState 62px 图标圈；
 *   - 状态：active/inactive、tone（StatusMark）、active/disabled（FilterChip）；
 *   - 真实动作边界：FilterChip disabled 不可交互、RowMenu 仅触发后出现且
 *     Escape/外部点击可关、危险项有独立样式；
 *   - 旁白不得成为组件：渲染任意共享组件都不应带出设计旁白文案。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Gauge, Laptop, LayoutDashboard, MessagesSquare } from "lucide-react";

import {
  ConsoleNavItem,
  EmptyState,
  FilterChip,
  Metric,
  MobileTabBar,
  RowMenu,
  StatusMark,
} from "@/components/console";

/**
 * 设计旁白清单（spec「视觉真源与旁白判定」明确排除的文案）。组件与 locale
 * 都不得出现；测试里渲染共享组件后扫一遍 textContent，守住「旁白不得成为组件」。
 */
const BANNED_NARRATION = [
  "这里记什么",
  "撤销这台设备",
  "现状 vs 优化",
  "只读改动说明",
  "执行目标按顺序",
  "改动在设备上",
  "N1",
  "N2",
];

function assertNoNarration(container: HTMLElement, where: string) {
  const text = container.textContent ?? "";
  for (const phrase of BANNED_NARRATION) {
    expect(text, `${where} 带出了旁白「${phrase}」`).not.toContain(phrase);
  }
}

describe("StatusMark（zF5jv）", () => {
  it("渲染圆角胶囊：装饰点 + 可见的文案（颜色不是状态的唯一表达）", () => {
    const { container } = render(<StatusMark tone="running" label="Online" />);
    // 文案是真实文本节点，不是 aria-hidden 的装饰。
    expect(screen.getByText("Online")).toBeTruthy();
    // 装饰点对读屏隐藏；胶囊本体不可点。
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).toContain("size-1.5");
    expect(dot?.className).toContain("rounded-full");
    assertNoNarration(container, "StatusMark");
  });

  it("胶囊本体与圆角尺寸固定（rounded-full + padding）", () => {
    const { container } = render(
      <StatusMark testId="pill" tone="running" label="x" />,
    );
    const pill = container.querySelector('[data-testid="pill"]') as HTMLElement;
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("px-2.5");
    expect(pill.className).toContain("gap-1.5");
  });

  it.each([
    ["running", "bg-status-running-bg", "text-status-running"],
    ["waiting", "bg-status-waiting-bg", "text-status-waiting"],
    ["idle", "bg-secondary", "text-status-idle"],
    ["error", "bg-destructive-soft", "text-destructive"],
  ] as const)("tone=%s → 语义 token %s / %s", (tone, bg, text) => {
    const { container } = render(
      <StatusMark testId="pill" tone={tone} label="x" />,
    );
    const pill = container.querySelector('[data-testid="pill"]') as HTMLElement;
    expect(pill.className).toContain(bg);
    expect(pill.className).toContain(text);
  });
});

describe("Metric（IhldU 统计卡）", () => {
  it("渲染 label / value / unit / sub，图标是装饰", () => {
    const { container } = render(
      <Metric
        label="Devices online"
        value="2"
        unit="/ 3"
        sub="Mac mini offline"
        icon={Gauge}
      />,
    );
    expect(screen.getByText("Devices online")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("/ 3")).toBeTruthy();
    expect(screen.getByText("Mac mini offline")).toBeTruthy();
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    assertNoNarration(container, "Metric");
  });

  it("value 尺寸固定为 text-[23px] font-bold；unit/sub 缺省不渲染", () => {
    const { container } = render(<Metric label="Used today" value="—" />);
    const value = container.querySelector(
      '[data-testid="metric-value"]',
    ) as HTMLElement;
    expect(value.className).toContain("text-[23px]");
    expect(value.className).toContain("font-bold");
    expect(container.querySelector('[data-testid="metric-unit"]')).toBeNull();
    expect(container.querySelector('[data-testid="metric-sub"]')).toBeNull();
  });

  it("默认 tone 用 card 面；danger tone 换 destructive 语义 token", () => {
    const { container, rerender } = render(<Metric label="A" value="1" />);
    let tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain("bg-card");
    expect(tile.className).toContain("border-border");

    rerender(<Metric tone="danger" label="A" value="1" sub="boom" />);
    tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain("bg-destructive-soft");
    expect(tile.className).toContain("border-destructive");
    const value = container.querySelector(
      '[data-testid="metric-value"]',
    ) as HTMLElement;
    expect(value.className).toContain("text-destructive");
  });
});

describe("FilterChip（rNQXR）", () => {
  it("默认是按钮：渲染文案，点击触发 onClick", () => {
    const onClick = vi.fn();
    render(<FilterChip label="All" onClick={onClick} />);
    const chip = screen.getByRole("button", { name: "All" });
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
    assertNoNarration(document.body, "FilterChip");
  });

  it("active 态：primary-soft 面 + primary-text，aria-pressed=true", () => {
    render(<FilterChip label="All" active />);
    const chip = screen.getByRole("button", { name: "All" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.className).toContain("bg-primary-soft");
    expect(chip.className).toContain("text-primary-text");
  });

  it("尺寸固定 h-[22px] rounded-full；inactive 用 secondary 面", () => {
    render(<FilterChip label="All" />);
    const chip = screen.getByRole("button", { name: "All" });
    expect(chip.className).toContain("h-[22px]");
    expect(chip.className).toContain("rounded-full");
    expect(chip.className).toContain("bg-secondary");
  });

  it("disabled：不是按钮、不可点、aria-disabled、不在焦点序里", () => {
    const onClick = vi.fn();
    render(<FilterChip label="All" disabled onClick={onClick} />);
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    const chip = screen.getByText("All") as HTMLElement;
    expect(chip.closest("[aria-disabled=true]")).toBeTruthy();
    expect(chip.getAttribute("tabindex")).toBeNull();
    fireEvent.click(chip);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("EmptyState（正式空态画板）", () => {
  it("渲染 62px 图标圈 + 标题 + 正文 + 可选动作；图标装饰", () => {
    const { container } = render(
      <EmptyState
        icon={Laptop}
        title="No conversations yet"
        body="Pick an agent to start."
        action={<button type="button">Start</button>}
      />,
    );
    expect(screen.getByText("No conversations yet")).toBeTruthy();
    expect(screen.getByText("Pick an agent to start.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    const box = container.querySelector(
      '[data-testid="empty-icon"]',
    ) as HTMLElement;
    expect(box.className).toContain("size-[62px]");
    expect(box.className).toContain("rounded-full");
    expect(box.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    assertNoNarration(container, "EmptyState");
  });

  it("brand 与 warn 两种图标圈底色都来自语义 token", () => {
    const { container, rerender } = render(
      <EmptyState icon={Laptop} title="t" />,
    );
    let box = container.querySelector(
      '[data-testid="empty-icon"]',
    ) as HTMLElement;
    expect(box.className).toContain("bg-primary-soft");
    rerender(<EmptyState icon={Laptop} title="t" tone="warn" />);
    box = container.querySelector('[data-testid="empty-icon"]') as HTMLElement;
    expect(box.className).toContain("bg-status-waiting-bg");
  });

  it("title 与正文都是可读文本（诚实空态能被辅助技术识别）", () => {
    const { container } = render(<EmptyState icon={Laptop} title="Empty" />);
    const title = screen.getByText("Empty");
    expect(title.tagName).toBe("P");
    // 标题不落在 aria-hidden 容器里。
    expect(container.querySelector('[aria-hidden="true"] p')).toBeNull();
  });
});

describe("ConsoleNavItem（ZC7pI）", () => {
  /** route = 当前路由；to = 导航项目标（缺省等于 route，即命中态）。 */
  function renderNav({
    route,
    to = route,
    ...props
  }: { route: string; to?: string } & Record<string, unknown>) {
    return render(
      <MemoryRouter initialEntries={[route]}>
        <ConsoleNavItem
          to={to}
          label="Overview"
          Icon={LayoutDashboard}
          {...props}
        />
      </MemoryRouter>,
    );
  }

  it("渲染为指向 to 的链接，尺寸 h-[34px]、图标 size-[17px]", () => {
    const { container } = renderNav({ route: "/overview" });
    const link = screen.getByRole("link", { name: "Overview" }) as HTMLElement;
    expect(link.getAttribute("href")).toBe("/overview");
    expect(link.className).toContain("h-[34px]");
    // jsdom 里 SVG 的 className 是 SVGAnimatedString，用 class 属性断言。
    expect(
      container.querySelector('svg[aria-hidden="true"]')?.getAttribute("class"),
    ).toContain("size-[17px]");
    assertNoNarration(container, "ConsoleNavItem");
  });

  it("当前路由命中 active：primary-soft 面 + aria-current=page", () => {
    renderNav({ route: "/overview" });
    const link = screen.getByRole("link", { name: "Overview" });
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.className).toContain("bg-primary-soft");
    expect(link.className).toContain("text-primary-text");
  });

  it("未命中路由用 muted 面", () => {
    renderNav({ route: "/chat", to: "/overview" });
    const link = screen.getByRole("link", { name: "Overview" });
    expect(link.getAttribute("aria-current")).toBeNull();
    expect(link.className).toContain("text-muted-foreground");
  });

  it("badge 只在 >0 时渲染；meta 与 dot 按需出现", () => {
    const { container, rerender } = renderNav({ route: "/chat", badge: 3 });
    expect(screen.getByText("3")).toBeTruthy();

    rerender(
      <MemoryRouter initialEntries={["/chat"]}>
        <ConsoleNavItem to="/chat" label="Overview" Icon={LayoutDashboard} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("3")).toBeNull();

    rerender(
      <MemoryRouter initialEntries={["/chat"]}>
        <ConsoleNavItem
          to="/chat"
          label="Overview"
          Icon={LayoutDashboard}
          meta="2/3"
          dot
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(container.querySelector('span[aria-hidden="true"]')).toBeTruthy();
  });
});

describe("MobileTabBar（A6Z3k）", () => {
  const items = [
    {
      key: "overview",
      to: "/overview",
      label: "Overview",
      Icon: LayoutDashboard,
    },
    { key: "chat", to: "/chat", label: "Chat", Icon: MessagesSquare },
  ];

  it("渲染每个目的地为链接，整体是带 aria-label 的导航", () => {
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <MobileTabBar items={items} ariaLabel="Primary" />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Chat" })).toBeTruthy();
    expect(nav.className).toContain("h-[74px]");
  });

  it("当前 tab 高亮（primary-text + 600），其余用 subtle", () => {
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <MobileTabBar items={items} />
      </MemoryRouter>,
    );
    const active = screen.getByRole("link", { name: "Overview" });
    const idle = screen.getByRole("link", { name: "Chat" });
    expect(active.className).toContain("text-primary-text");
    expect(idle.className).toContain("text-subtle-foreground");
    // 高亮 tab 的文案字重 600。
    expect(within(active).getByText("Overview").className).toContain(
      "font-semibold",
    );
    assertNoNarration(document.body, "MobileTabBar");
  });
});

describe("RowMenu（行级菜单语义）", () => {
  function renderMenu(
    items = [
      { key: "open", label: "Open", onSelect: vi.fn() },
      {
        key: "revoke",
        label: "Revoke",
        danger: true,
        onSelect: vi.fn(),
      },
    ],
  ) {
    return render(<RowMenu label="Row actions" items={items} />);
  }

  it("触发按钮带 aria-haspopup/aria-expanded，未开时无菜单", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Row actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    assertNoNarration(document.body, "RowMenu");
  });

  it("点击触发后出现菜单并聚焦首个 menuitem；危险项用 destructive 色", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
    const menu = screen.getByRole("menu");
    expect(menu).toBeTruthy();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Open", "Revoke"]);
    expect(document.activeElement).toBe(items[0]);
    expect(items[1].className).toContain("text-destructive");
  });

  it("选择菜单项后触发 onSelect 并关闭菜单", () => {
    const onOpen = vi.fn();
    const onRevoke = vi.fn();
    renderMenu([
      { key: "open", label: "Open", onSelect: onOpen },
      { key: "revoke", label: "Revoke", danger: true, onSelect: onRevoke },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape 关闭菜单并把焦点还给触发按钮", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Row actions" }),
    );
  });

  it("点击菜单外部关闭菜单", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
