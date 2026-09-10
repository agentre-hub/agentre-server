/**
 * 共享控制台基础组件（task 1，正式 Pencil 组件 ZC7pI/A6Z3k/zF5jv/rNQXR/
 * IhldU 统计卡提炼）。
 *
 * 这些组件是全轮共享视觉基础：后续页面只消费其 API，不允许复制其尺寸、
 * 状态颜色、字阶或交互语义。本测试固定：
 *   - 尺寸：NavItem h-[34px]、TabBar h-[74px]、FilterChip h-[22px]、
 *     StatusMark 圆角胶囊、Metric value text-[23px]、EmptyState 62px 图标圈；
 *   - 状态：active/inactive、tone（StatusMark）、active/disabled（FilterChip）；
 *   - 真实动作边界：FilterChip disabled 不可交互；行级菜单已归共享包，
 *     它的语义钉在 `row-actions-menu.test.tsx`（规格 2026-08-22 E 段）；
 *   - 旁白不得成为组件：渲染任意共享组件都不应带出设计旁白文案。
 */
import { statusConfig } from "@agentre-hub/agentre-ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  Gauge,
  Laptop,
  LayoutDashboard,
  ListFilter,
  MessagesSquare,
} from "lucide-react";

import {
  ConsoleNavItem,
  EmptyState,
  FilterChip,
  InlineEmpty,
  Metric,
  MobileTabBar,
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

  /**
   * 类名必须**取自**共享包的 `statusConfig`，不是照着它抄一份。
   *
   * 这条用例此前钉的是本站手抄的那份映射，四档全部与包不一致 —— 而且错在
   * 同一处：把**点**的颜色当**文字**颜色用了。浅色下 running 是 #10b981 压
   * #ecfdf5，对比度 2.41:1；waiting 是 #f59e0b 压 #fffbeb，2.07:1，都远低于
   * WCAG AA 正文要求的 4.5:1。`--status-*-text` 这一档 token 存在的全部理由
   * 就是「在 `-bg` 上当文字用」（包里是 5.21 / 4.84），本站没用它。
   *
   * 深色下 `-text` 与基色同值，所以这个缺陷只在浅色里显形 —— 这也是它能一直
   * 躺着的原因。断言直接读包的值而不是写字面量：包再改一次，本站跟着走。
   */
  it.each(["running", "waiting", "idle", "error"] as const)(
    "tone=%s → 胶囊与点的类名都来自包的 statusConfig",
    (tone) => {
      const { container } = render(
        <StatusMark testId="pill" tone={tone} label="x" />,
      );
      const pill = container.querySelector(
        '[data-testid="pill"]',
      ) as HTMLElement;
      for (const cls of statusConfig[tone].pillClassName.split(" ")) {
        expect(pill.className, `胶囊缺了 ${cls}`).toContain(cls);
      }

      // 点用 dotClassName（亮色信号），文字用 pillClassName 里的深色 —— 两者
      // 刻意不同色。此前点是 bg-current，于是跟着文字一起错。
      const dot = container.querySelector(
        'span[aria-hidden="true"]',
      ) as HTMLElement;
      expect(dot.className).toContain(statusConfig[tone].dotClassName);
    },
  );
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

  /*
    collapsed 是 56px 图标栏那一档（外壳的侧栏可以收起）。它改的是排布，不是这一
    项还剩多少信息——三条尾巴各有各的去处，而不是一起消失：

      文案 → sr-only：图标不是名字。视觉上收窄之后链接的可访问名要是也没了，
             读屏用户看到的就是六个「link」。
      meta → title：一行 mono 数字在 56px 里排不下，但「丢掉」和「换个地方说」
             不是一回事。
      badge → 图标角上：它是这条栏上唯一会变的东西。
  */
  it("collapsed：只剩图标，但可访问名、badge 与 meta 各自还在", () => {
    renderNav({ route: "/chat", to: "/devices", collapsed: true, meta: "2/3" });

    const link = screen.getByRole("link", { name: "Overview" });
    expect(link.className).toContain("justify-center");
    expect(link.className).not.toContain("px-2.5");
    expect(within(link).getByText("Overview").className).toContain("sr-only");
    // meta 不再占一行，改由悬浮说明承接。
    expect(screen.queryByText("2/3")).toBeNull();
    expect(link.getAttribute("title")).toBe("Overview 2/3");
  });

  it("collapsed 的 badge 挪到图标角上，数字本身不变", () => {
    renderNav({ route: "/chat", collapsed: true, badge: 3 });

    const badge = screen.getByText("3");
    expect(badge.className).toContain("absolute");
    // 定位要有参照系：链接自己得是 relative，否则角标会飞到最近的定位祖先上。
    expect(screen.getByRole("link", { name: /Overview/ }).className).toContain(
      "relative",
    );
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
    expect(idle.className).toContain("text-muted-foreground");
    // 高亮 tab 的文案字重 600。
    expect(within(active).getByText("Overview").className).toContain(
      "font-semibold",
    );
    assertNoNarration(document.body, "MobileTabBar");
  });

  // 窄屏此前完全看不到「有多少条在等你」：外壳派生移动 tabs 时把 badge 丢掉了。
  // 底部这条栏是移动端的主导航，那颗角标该在的地方就是这里。
  it("角标与侧栏同一形状：>0 才画，带 title 说明它是什么", () => {
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <MobileTabBar
          items={[items[0], { ...items[1], badge: 3, badgeLabel: "3 unread" }]}
        />
      </MemoryRouter>,
    );
    const chat = screen.getByRole("link", { name: /Chat/ });
    expect(within(chat).getByText("3")).toBeTruthy();
    expect(within(chat).getByTitle("3 unread")).toBeTruthy();
  });

  it("0 与「没问出来」都不画——一个显示出来的 0 会被读成「都处理完了」", () => {
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <MobileTabBar
          items={[
            { ...items[0], badge: 0 },
            { ...items[1], badge: null },
          ]}
        />
      </MemoryRouter>,
    );
    expect(
      within(screen.getByRole("link", { name: /Overview/ })).queryByText("0"),
    ).toBeNull();
    expect(
      within(screen.getByRole("link", { name: /Chat/ })).queryByText(/^\d+$/),
    ).toBeNull();
  });
});

/**
 * 索引栏里的空态与页面级 EmptyState 是两件事：后者是一整块面板没内容（62px 图标圈、
 * 18px 粗标题），前者是一条**窄栏**里当前这一屏筛空了。此前三处索引空态各画各的
 * ——组织面的「未找到 Agent」是整栏垂直居中的一句 mono 小字，同一个面板下面的
 * 「还没有任何部门」却是顶端的虚线卡片，会话索引又是第三种（裸图标 + 一行灰字 +
 * 一个手搓的 border 按钮）。同一个信息层级三种形，这是「一个概念一个实现」的反例。
 *
 * InlineEmpty 把它们收成一种：虚线卡片、顶端对齐、图标 + 标题 + 正文 + 一条回程。
 */
describe("InlineEmpty（索引栏内空态）", () => {
  it("虚线卡片 + 顶端对齐：不把一句话吊在整栏正中", () => {
    const { container } = render(
      <InlineEmpty
        icon={ListFilter}
        title="Nothing here"
        body="12 conversations in your account."
        action={<button type="button">See all</button>}
        testId="inline-empty"
      />,
    );
    const box = screen.getByTestId("inline-empty");
    expect(box.className).toContain("border-dashed");
    expect(box.className).toContain("rounded-lg");
    // 顶端对齐：不能是 h-full + justify-center（那会在长栏里留一大块空白）。
    expect(box.className).not.toContain("h-full");
    expect(box.className).not.toContain("justify-center");
    expect(screen.getByText("Nothing here").tagName).toBe("P");
    expect(screen.getByText("12 conversations in your account.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "See all" })).toBeTruthy();
    assertNoNarration(container, "InlineEmpty");
  });

  it("图标是装饰，正文与动作都可缺席", () => {
    const { container } = render(
      <InlineEmpty icon={ListFilter} title="Empty" testId="inline-empty" />,
    );
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getByText("Empty")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
