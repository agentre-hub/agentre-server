/**
 * 统一会话索引（规格 2026-08-17，数据源改镜像 2026-08-18）：一个列表、四个轴。
 *
 * 这里守的是渲染侧的约定——分组投影本身在 session-axes.test.ts 里守：
 *  1. 轴选择器切得动，切完组头跟着换。
 *  2. 决策 8：分组说了哪一维，行首字形与第二行就补另外两维。
 *  3. 时间轴没有组头，三维全落在第二行。
 *  4. 机器轴上离线的机器组头标「离线」；别的轴上离线是第二行末尾的一段字
 *     （2026-08-18 决策 10：机器离线只影响能不能发新消息，不影响读）。
 *  5. 还没保存进账号的行带一个「保存」；已保存的行右键菜单里有「删除」。
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeleteSessionDialog from "@/components/session/DeleteSessionDialog";
import SessionIndex from "@/components/session/SessionIndex";
import { formatRelativeTime } from "@/lib/sessionView";
import i18n from "@/i18n";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // 组的收放状态是真的记在 localStorage 里的（共享包的 persistenceKey）。
  // 不清掉的话，前一条用例收起来的组会让后一条从收起态开始，断言随执行顺序变。
  localStorage.clear();
});

/**
 * 项目 / Agent 的 color 是**颜色 token**（"agent-1"…"agent-16" / "neutral"），
 * 不是 CSS 颜色——写成十六进制的话浏览器会把整条 backgroundColor 丢掉，
 * 索引里一个色都上不了。fixture 因此用真 token。
 */
const projects = [
  {
    syncId: "p-server",
    name: "agentre-server",
    color: "agent-11",
    // 项目自己的图标键（共享包 org/icon-registry 的 key）。词表与「key → 图标」
    // 都在包里，字形因此自己解得出来，不再等宿主递一个画好的节点。
    icon: "code-xml",
    sortOrder: 0,
  },
  {
    syncId: "p-web",
    name: "agentre-web",
    color: "agent-3",
    sortOrder: 1,
  },
];
const agents = [{ syncId: "ag-fe", name: "Frontend Agent", color: "agent-5" }];
const machines = [
  { deviceId: 20, name: "Studio box", online: true },
  { deviceId: 21, name: "Old laptop", online: false },
];

function row(over: Partial<MirrorIndexRow> & { key: string }): MirrorIndexRow {
  return {
    // 行的身份是 conversation_id（决策 1）。用例里给的是短号：宿主不校验它的形状
    // ——它只把这个值原样放进 URL 与交给宿主的回调。
    conversationId: "42",
    // 共享包那一格旧身份本宿主一律不读，见 chatRows 的 MirrorIndexRow。
    sessionId: 0,
    deviceId: 20,
    fingerprint: "fp-a",
    // 测试行由同一台机器发起并承载。
    machineFingerprint: "fp-a",
    agentSyncId: "ag-fe",
    projectSyncId: "p-server",
    updatedAt: 1_700_000_000_000,
    title: "重构登录页",
    lifecycleState: "running",
    // 索引的行来自账号镜像，因此默认就是「已保存」的那一种。
    saved: true,
    ...over,
  };
}

/**
 * 按组头文案挑出那一个组头。
 *
 * 四种组头都是共享包那几件（包 3a49c1ee「四种组头收进同一个外壳」），内部的
 * chevron / 字形因此共用一套 testId；同屏有好几个组时得先圈到这一个组头里再查。
 */
function groupHeaderFor(label: string): HTMLElement {
  const header = screen
    .getAllByTestId("group-header")
    .find((el) => el.textContent?.includes(label));
  if (!header) throw new Error(`没有文案含「${label}」的组头`);
  return header;
}

/**
 * 组头上那颗**收放**按钮。
 *
 * 按名字取不行：组头上现在还有一颗「导入本地会话」的 ⋮，它的无障碍名同样带着组名
 * （「<组名> 的更多操作」）。两颗都是 button，只有收放这一颗带 aria-expanded。
 */
function groupToggleFor(label: string): HTMLElement {
  const toggle = within(groupHeaderFor(label))
    .getAllByRole("button")
    .find((el) => el.hasAttribute("aria-expanded"));
  if (!toggle) throw new Error(`「${label}」的组头上没有收放按钮`);
  return toggle;
}

function renderIndex(
  props: Partial<React.ComponentProps<typeof SessionIndex>>,
) {
  const onAxisChange = vi.fn();
  const view = render(
    <ThemeProvider>
      <MemoryRouter>
        <SessionIndex
          axis="project"
          onAxisChange={onAxisChange}
          rows={[row({ key: "a" })]}
          projects={projects}
          agents={agents}
          machines={machines}
          filter="all"
          onFilterChange={vi.fn()}
          sessionPath={(deviceId, conversationId) =>
            `/devices/${deviceId}/sessions/${conversationId}`
          }
          {...props}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );
  return { ...view, onAxisChange };
}

/**
 * 打开一个 Radix 菜单。它的触发是 `pointerdown`（不是 click）—— 与
 * `user-menu.test.tsx` 里已有的写法同一套。
 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

/**
 * 行首那一槽（共享包 `RowLeadingSlot`）。
 *
 * 断言分两层，因为职责就是两层：**槽位**锁死 14px（换轴时列表不左右跳），
 * `data-kind` 说这一档画的是哪一维；**字形**是槽里那一枚方块，颜色 / 首字 /
 * 中性面兜底都在它身上。此前本站自己画这两层，testid 里带着行的 key；现在两端
 * 用的是包里同一份，因此读的也是包的契约。
 */
function leadingSlot() {
  return screen.getByTestId("row-leading-slot");
}

function leadingGlyph() {
  return leadingSlot().firstElementChild as HTMLElement;
}

describe("统一会话索引", () => {
  it("轴选择器切得动：选了别的轴就把这件事报给宿主（轴由宿主持有，设备下钻要预置它）", () => {
    const { onAxisChange } = renderIndex({});

    openMenu(screen.getByTestId("axis-picker"));
    fireEvent.click(screen.getByTestId("axis-option-machine"));

    expect(onAxisChange).toHaveBeenCalledWith("machine");
  });

  /**
   * Escape 关掉它。
   *
   * 这条用例的注释换过一次，值得留着：此前它写的是「手搓的 `role="menu"` 得自己
   * 收拾键盘……触发按钮是菜单的兄弟节点，把 onKeyDown 挂在菜单自己身上等于没挂」。
   * 那正是自己实现菜单的代价 —— 每一条键盘语义都要手工补一遍，而且是出了问题
   * 才补。现在这个菜单是本站已有的 Radix `DropdownMenu`（`UserMenu` 一直在用的
   * 那个），键盘语义由它负责，这里只钉住结果。
   */
  it("Escape 关掉轴选择器", () => {
    renderIndex({});
    const trigger = screen.getByTestId("axis-picker");

    openMenu(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * 选择器是「图标 + 当前值 + chevron」（桌面端决策 3，共享包 `AxisPicker` 就是
   * 那一份）：项目档用的是行首那一枚文件夹记号——选择器说的「项目」和行里画的
   * 「项目」必须是同一个记号，只剩文字的话两处对不上。
   */
  it("轴选择器带当前轴的图标，菜单里每一档也各带自己的图标", () => {
    renderIndex({ axis: "agent" });
    const trigger = screen.getByTestId("axis-picker");

    // 当前轴的图标 + chevron：只有 chevron 的话说明还是纯文字那一份。
    expect(trigger.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
    // 轴的文案现在住在共享包自己的 namespace 里（本站那份同名副本已经删掉——
    // 同一句话两份，改一边就是静默分叉）。
    expect(trigger.textContent).toContain(
      i18n.t("agentreUi:sessionIndex.axis.agent"),
    );

    openMenu(trigger);
    for (const axis of ["project", "agent", "time", "machine"]) {
      expect(
        screen.getByTestId(`axis-option-${axis}`).querySelector("svg"),
        `「${axis}」这一档没有图标`,
      ).toBeTruthy();
    }
  });

  /**
   * 机器选择器与「在这台机器上找」一起下线（规格 2026-08-21 决策 5）：每台机器
   * 各自一组、实时清单直接铺开，再摆一个「选一台」的菜单就是同一件事两个入口。
   */
  it("机器轴上不再有机器选择器", () => {
    renderIndex({ axis: "machine" });

    expect(screen.queryByTestId("machine-picker")).toBeNull();
  });

  /**
   * 菜单必须落在滚动容器**之外**。
   *
   * 索引住在 `Chat.tsx` 的 `overflow-auto` 栏里。此前的菜单是 `absolute left-0
   * top-8` 定位在那个容器**内部**的普通节点 —— 于是它被容器裁切，也会跟着内容
   * 一起滚走。这在 jsdom 里量不到像素，但**机制**是结构性的、量得到：
   * 只要菜单还是滚动祖先的后代，裁切就成立。portal 出去才不成立。
   */
  it("菜单 portal 到滚动容器之外（否则被 overflow-auto 裁掉）", () => {
    const { container } = renderIndex({});
    // 复刻 Chat.tsx:841 那一层 `min-h-0 flex-1 overflow-auto`。
    const scroller = container.firstElementChild as HTMLElement;
    scroller.style.overflow = "auto";

    openMenu(screen.getByTestId("axis-picker"));

    const menu = screen.getByRole("menu");
    expect(
      scroller.contains(menu),
      "菜单还在滚动容器里，会被 overflow-auto 裁掉、也会跟着滚走",
    ).toBe(false);
  });

  /**
   * 打开后焦点进入菜单。
   *
   * 判据不是「Radix 这么做」，是**本仓自己的菜单标准**：`components/console/
   * RowMenu.tsx` 的文档注释写着「打开后焦点进入菜单（↑↓/Home/End 在项间移动），
   * Escape 关闭并把焦点还给触发按钮」。同一个应用里两个菜单两套键盘语义，
   * 对键盘与读屏用户就是两种东西。
   */
  it("打开后焦点进入菜单，Escape 之后还给触发按钮", async () => {
    renderIndex({});
    const trigger = screen.getByTestId("axis-picker");

    openMenu(trigger);
    const menu = screen.getByRole("menu");
    expect(
      menu.contains(document.activeElement),
      "焦点还留在触发按钮上：读屏用户听到 expanded，却不知道菜单里有什么",
    ).toBe(true);

    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });

    // 焦点归还是**异步**的（Radix 在内容卸载后才还），所以这里等一下 ——
    // 不等的话读到的是关闭那一瞬间的 body。
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * 轴选择器与筛选 chips 同属**一行**。320px 栏减掉内边距还有 300px，量下来轴
   * 选择器加三个 chip 是 258px（放得下），只有机器轴多一个机器选择器才到 334px
   * （放不下）。放不下时三个 chip 要**整体**折到第二行 —— 把它们和选择器摊在同一
   * 个 flex 容器里的话，flex-wrap 只会把最后那个「等你处理」单独甩下去。
   */
  it("轴选择器与筛选 chips 同属一行，chips 自成一个整体（放不下时三个一起折行）", () => {
    renderIndex({ axis: "machine" });
    const controls = screen.getByTestId("index-controls");

    expect(controls.contains(screen.getByTestId("axis-picker"))).toBe(true);

    // chips 是控制行的**直接**子节点：折行时整块搬动，不会散成三个。
    const chips = screen.getByTestId("index-filter-chips");
    expect(chips.parentElement).toBe(controls);
    for (const key of ["all", "running", "unread"]) {
      expect(chips.contains(screen.getByTestId(`filter-chip-${key}`))).toBe(
        true,
      );
    }
  });

  it("项目轴：组头是项目，行首字形是 Agent（决策 8 —— 分组没说的那一维落在行上）", () => {
    renderIndex({ axis: "project" });

    expect(screen.getByText("agentre-server")).toBeTruthy();
    expect(leadingSlot().dataset.kind).toBe("agent-avatar");
  });

  it("Agent 轴：组头是 Agent，行首字形换成项目字形", () => {
    renderIndex({ axis: "agent" });

    expect(screen.getByText("Frontend Agent")).toBeTruthy();
    expect(leadingSlot().dataset.kind).toBe("project-avatar");
  });

  /**
   * 项目组头与「随手对话」组头都有 ＋，Agent 组头此前没有——同一份索引里换一条轴，
   * 「在这一组里开一条」这个入口就没了（桌面端 AgentGroup 上那颗一直在）。
   */
  it("Agent 组头上那颗 ＋ 报的是哪个 Agent，且不把这一组收起来", () => {
    const onAgentNewSession = vi.fn();
    renderIndex({ axis: "agent", onAgentNewSession });

    const header = groupHeaderFor("Frontend Agent");
    expect(groupToggleFor("Frontend Agent").getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.click(within(header).getByTestId("group-header-plus"));

    expect(onAgentNewSession).toHaveBeenCalledWith("ag-fe");
    // ＋ 在收放按钮之外：点它不该顺手折叠这一组。
    expect(groupToggleFor("Frontend Agent").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("没有 Agent 标识的那一组不摆 ＋——那儿没有「哪个 Agent」可谈", () => {
    renderIndex({
      axis: "agent",
      rows: [row({ key: "a", agentSyncId: "" })],
      onAgentNewSession: vi.fn(),
    });

    const header = groupHeaderFor(
      i18n.t("sessionIndex.group.unnamedAgent") as string,
    );
    expect(within(header).queryByTestId("group-header-plus")).toBeNull();
  });

  /**
   * 决策 8 把行首那一维**照搬桌面端决策 4**，而那一条写的是「自由会话在「按 Agent」
   * 下槽位保留、字形置灰，行的左缘不参差」，并明确拒绝了「这一维缺席就不渲染字形」。
   * 共享 `SessionRow` 的 `leading` 是普通 flex 子项、不给空槽留位，所以缺席时不画
   * 字形 = 那一行的标题整体左移，与相邻行不齐。
   */
  it("行首槽位固定：那一维解析不出来时字形置灰，不是不画（左缘不参差）", () => {
    renderIndex({
      axis: "agent",
      rows: [row({ key: "a", projectSyncId: "" })],
    });

    // 槽位照旧在，只是里面那一枚不认领任何项目。
    expect(leadingSlot().dataset.kind).toBe("free-glyph");
    expect(leadingGlyph().className).toContain("bg-secondary");
  });

  it("行首槽位固定：项目轴上没有 Agent 标识的老会话同样保留槽位", () => {
    renderIndex({
      axis: "project",
      rows: [row({ key: "a", agentSyncId: "" })],
    });

    expect(leadingSlot().dataset.kind).toBe("agent-avatar");
    expect(leadingSlot().className).toContain("size-3.5");
  });

  it("时间轴：没有组头，三维全写进第二行", () => {
    renderIndex({ axis: "time" });

    expect(screen.queryByTestId("group-header")).toBeNull();
    const second = screen.getByTestId("row-secondary-a");
    expect(second.textContent).toContain("Frontend Agent");
    expect(second.textContent).toContain("agentre-server");
    expect(second.textContent).toContain("Studio box");
  });

  /**
   * 决策 7：不属于任何项目是一个**正当的去处**，不是分类失败的残留——所以项目
   * 那一维缺席时如实写出「随手对话」并把字形置灰，而不是整段省掉。省掉的话，
   * 同一个时间轴上有的行三维、有的行两维，读者会以为那一行的项目丢了。
   */
  it("时间轴：不属于任何项目的行，项目那一维写「随手对话」而不是整段省掉", () => {
    renderIndex({ axis: "time", rows: [row({ key: "a", projectSyncId: "" })] });

    const second = screen.getByTestId("row-secondary-a");
    expect(second.textContent).toContain(
      i18n.t("sessionIndex.group.unassignedProject"),
    );
  });

  it("机器轴：离线的机器组头如实标离线（机器认得出来但连不上）", () => {
    renderIndex({
      axis: "machine",
      rows: [row({ key: "a" }), row({ key: "b", deviceId: 21 })],
    });

    expect(screen.getByTestId("group-offline-device-21")).toBeTruthy();
    expect(screen.queryByTestId("group-offline-device-20")).toBeNull();
  });

  /**
   * 2026-08-18 决策 10：本体在 server 上，机器离线因此只是行上的一个状态——
   * 行照常有标题 / 状态 / 归属、照常点得进去，「离线」是第二行末尾的一段字，
   * 不是把整行置灰。
   */
  it("机器离线时行照常可点，「离线」只是第二行末尾跟在机器名后面的一段字", () => {
    renderIndex({ axis: "project", rows: [row({ key: "a", deviceId: 21 })] });

    const second = screen.getByTestId("row-secondary-a");
    expect(second.textContent).toContain("Old laptop");
    expect(second.textContent).toContain("Offline");
    // 行仍是可点的真链接，不是灰行。
    const link = screen.getByRole("link", { name: /重构登录页/ });
    expect(link.getAttribute("href")).toBe("/devices/21/sessions/42");
    expect(link.getAttribute("aria-disabled")).toBeNull();
  });

  it("机器在线时第二行不多这一段（不给每一行都印一个状态）", () => {
    renderIndex({ axis: "project", rows: [row({ key: "a" })] });

    expect(screen.getByTestId("row-secondary-a").textContent).not.toContain(
      "Offline",
    );
  });

  it("行是可点的真链接：中键 / ⌘ 点击 / 右键复制地址都得成立", () => {
    renderIndex({ axis: "project" });

    expect(
      screen.getByRole("link", { name: /重构登录页/ }).getAttribute("href"),
    ).toBe("/devices/20/sessions/42");
  });

  /**
   * 规格 2026-08-21-root-project-entry 决策 4 / 6。
   *
   * 决策 10 的「一条会话都没有就交白卷」在**项目轴上不再成立**：项目名单是账号
   * 直接给的，不是从会话推出来的，所以这一轴答得出「有哪些项目」。这不是可有可无
   * 的一点体贴——组头是「机器与路径…」「成员…」「未配置」角标唯一的挂点，
   * 组头不在，刚建出来的项目就再也配不了路径，也就永远开不出对话。
   *
   * 空态那句话照旧同时在：组头说的是「有这些项目」，那一句说的是「一条对话都
   * 还没有」，两句话不冲突。
   */
  it("项目轴：一条会话都没有时，账号里的项目照样出组头，空态那句话同时在", () => {
    renderIndex({ rows: [], axis: "project" });

    expect(
      screen.getAllByTestId("group-header").map((h) => h.textContent),
    ).toEqual([
      expect.stringContaining("agentre-server"),
      expect.stringContaining("agentre-web"),
    ]);
    expect(screen.getByTestId("session-index-empty")).toBeTruthy();
  });

  /**
   * 规格 2026-08-21-root-project-entry 决策 1。
   *
   * 在此之前，能建项目的地方只有组头菜单的「新建子项目…」，它必定带一个父项目
   * ——于是账号里一个项目都没有时建不出第一个，也建不出与现有项目平级的那种。
   * 这颗按钮摆在控件行而不是组头上，正因为它要在「一个组头都没有」时也在。
   */
  it("项目轴：控件行上有「新建项目」，点它把这件事报给宿主", () => {
    const onNewProject = vi.fn();
    renderIndex({ onNewProject });

    const trigger = screen.getByTestId("index-new-project");
    // 只有图标，因此可访问名必须自己给：读屏上这个名字就是它的全部。
    expect(trigger.getAttribute("aria-label")).toBe("New project");
    fireEvent.click(trigger);

    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it("别的轴上不摆「新建项目」：那几轴没有项目这一维，摆了就是问一个它答不出的问题", () => {
    renderIndex({ axis: "agent", onNewProject: vi.fn() });

    expect(screen.queryByTestId("index-new-project")).toBeNull();
  });

  it("宿主没给去处时也不摆：索引不替页面决定点了之后去哪", () => {
    renderIndex({});

    expect(screen.queryByTestId("index-new-project")).toBeNull();
  });

  it("Agent 轴：一条会话都没有时仍然交白卷，不摆一列空组头（决策 10）", () => {
    renderIndex({ rows: [], axis: "agent" });

    expect(screen.queryByTestId("group-header")).toBeNull();
    expect(screen.getByTestId("session-index-empty")).toBeTruthy();
  });

  /**
   * 规格「已知的可见变化」3：共享 `StatusDot` 的可访问名收敛成英文状态码，
   * **移动端行尾另有本地化文字徽标兜底**。徽标由宿主开（只有它知道自己是移动形态），
   * 桌面端不开——那一端的状态由状态点承担。
   */
  it("宿主要求时行尾摆本地化状态徽标（移动端兜底）", () => {
    // 有理由时徽标说的就是**理由**（与桌面端同一条：共享包的行尾优先说「为什么需要
    // 你」）。不能两样都摆：「审批」与「运行中」同时出现在一行里是自相矛盾的两句话。
    renderIndex({
      axis: "time",
      rows: [row({ key: "a", waitingForInput: true })],
      rowStatusLabel: true,
    });

    expect(screen.getByText("Approval")).toBeTruthy();
  });

  it("没有理由可说时退回生命周期的本地化说法", () => {
    // 兜底本身仍在（规格「已知的可见变化」3：共享 StatusDot 的可访问名只剩英文状态
    // 码，行上得有一处看得见的本地化状态）。读过的闲置会话就是这一档。
    renderIndex({
      axis: "time",
      rows: [
        row({
          key: "a",
          lifecycleState: "idle",
          updatedAt: 1_000,
          lastReadAt: 2_000,
        }),
      ],
      rowStatusLabel: true,
    });

    expect(screen.getByText("Idle")).toBeTruthy();
  });

  it("宿主没要求时不摆（桌面端行尾只有最后活动时间）", () => {
    renderIndex({
      axis: "time",
      rows: [row({ key: "a", waitingForInput: true })],
    });

    expect(screen.queryByText("Waiting for your input")).toBeNull();
  });
});

/**
 * 颜色与字形（用户复核 2026-08-18）。
 *
 * 索引拿到的 `color` 是**颜色 token**（"agent-1"…"agent-16" / "neutral"，共享包
 * `agentColorOrder` 是它的全集），不是 CSS 颜色。`backgroundColor: "agent-11"` 是
 * 非法值，浏览器整条丢掉——项目色 / Agent 色因此一个都没上过。取色统一走共享包的
 * `tokenToCssColor`，断言落在**看得见的结果**上：内联样式是不是那个 CSS 变量。
 *
 * 项目那一维的字形是「项目色圆角方块 + 项目名首字」，**组头与行里同一枚**：同一个
 * 项目在两处长得不一样的话，那枚字形说不出它是哪个项目。
 */
describe("统一会话索引：颜色 token 与项目字形", () => {
  it("项目字形上的是 token 对应的 CSS 变量（token 直接塞 backgroundColor 等于没上色）", () => {
    renderIndex({ axis: "agent" });

    const glyph = leadingGlyph();
    expect(glyph.style.backgroundColor).toBe("var(--agent-11)");
    // 颜色只能进内联样式：`cn(..., color || "bg-secondary")` 这种写法会把
    // "var(--agent-11)" 本身当成类名塞进 class 列表（一个不存在的类，静默无效）。
    expect(glyph.className).not.toContain("var(");
  });

  it("项目色是非法 token 时不写内联颜色，退回中性面（不拿脏字符串当颜色）", () => {
    renderIndex({
      axis: "agent",
      projects: [
        {
          syncId: "p-server",
          name: "agentre-server",
          color: "#zzz",
          sortOrder: 0,
        },
      ],
    });

    const glyph = leadingGlyph();
    expect(glyph.style.backgroundColor).toBe("");
    expect(glyph.className).toContain("bg-secondary");
  });

  it("Agent 字形同样走 token", () => {
    renderIndex({ axis: "project" });

    expect(leadingGlyph().style.backgroundColor).toBe("var(--agent-5)");
  });

  /**
   * 与桌面端对齐（用户裁决 2026-08-18「对齐一下 Agentre-desktop 的」）：
   * 两维是**同一个 14px 圆角方块、同一个槽位**（桌面端 row-leading-slot.tsx 把
   * 槽位尺寸锁死，换轴时列表才不会左右跳）。Agent = 颜色 + 首字母，
   * 此前那枚 8px 色点是漂移，不是设计。
   *
   * 首字母的取法在 2026-08-21 那一轮随字形归一改成桌面端那套（规格决策 6）：
   * 拉丁多词名取前两词首字母（`Frontend Agent` → `FA`），其余取首字。
   */
  it("Agent 字形是 14px 圆角方块 + 首字母，不是 8px 色点", () => {
    renderIndex({ axis: "project" });

    expect(leadingGlyph().textContent).toBe("FA");
    // 14px 在槽位上（包里那一份把尺寸锁在槽上，字形填满它）。
    expect(leadingSlot().className).toContain("size-3.5");
    expect(leadingGlyph().className).toContain("rounded-sm");
    expect(leadingGlyph().className).not.toContain("rounded-full");
  });

  it("两维的槽位一样大：换轴时行首不换尺寸（列表不跳）", () => {
    const { unmount } = renderIndex({ axis: "project" });
    const agentSlot = leadingSlot().className;
    const agentGlyph = leadingGlyph().className;
    unmount();

    renderIndex({ axis: "agent" });
    const projectSlot = leadingSlot().className;
    const projectGlyph = leadingGlyph().className;

    expect(agentSlot).toBe(projectSlot);
    for (const cls of ["rounded-sm"]) {
      expect(agentGlyph).toContain(cls);
      expect(projectGlyph).toContain(cls);
    }
  });

  it("项目选过图标就画那一枚：解 key 这一步在共享包里，本站不必递节点", () => {
    renderIndex({ axis: "agent" });

    const glyph = leadingGlyph();
    expect(glyph.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-code-xml",
    );
    // 图标顶掉首字，而不是叠在它上面。
    expect(glyph.textContent).toBe("");
  });

  it("项目没选过图标时退回项目名首字：猜一枚图标比一个字母更糟", () => {
    renderIndex({
      axis: "agent",
      projects: [
        {
          syncId: "p-server",
          name: "agentre-server",
          color: "agent-11",
          sortOrder: 0,
        },
      ],
    });

    expect(leadingGlyph().textContent).toBe("a");
  });

  it("没有项目时槽位保留、给中性面 + 「随手对话」那枚字形，不是空槽", () => {
    renderIndex({
      axis: "agent",
      rows: [row({ key: "a", projectSyncId: "" })],
    });

    expect(leadingSlot().dataset.kind).toBe("free-glyph");
    const glyph = leadingGlyph();
    expect(glyph.className).toContain("bg-secondary");
    expect(glyph.querySelector("svg")).toBeTruthy();
  });

  it("Agent 色是非法 token 时同样不写内联颜色", () => {
    renderIndex({
      axis: "project",
      agents: [{ syncId: "ag-fe", name: "Frontend Agent", color: "nope" }],
    });

    expect(leadingGlyph().style.backgroundColor).toBe("");
  });

  it("项目字形是项目色方块 + 它自己那枚记号，不是一枚通用文件夹描边", () => {
    renderIndex({ axis: "agent" });

    const glyph = leadingGlyph();
    expect(glyph.tagName).toBe("SPAN");
    expect(glyph.className).toContain("rounded-sm");
    expect(glyph.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-code-xml",
    );
  });

  it("判不出项目时保留槽位、给中性面、不编名字（决策 8：字形置灰不是不画）", () => {
    renderIndex({
      axis: "agent",
      rows: [row({ key: "a", projectSyncId: "" })],
    });

    const glyph = leadingGlyph();
    expect(glyph.textContent).toBe("");
    expect(glyph.className).toContain("bg-secondary");
    expect(glyph.style.backgroundColor).toBe("");
  });

  it("没有 Agent 标识的老会话同样保留槽位，字形按桌面端画成 agent-1 + ?", () => {
    // 规格 2026-08-21 决策 5（用户裁决「以桌面端 UI/UX 为准」）：这一格此前是
    // 中性方块、不编身份；桌面端画的是 agent-1 底色 + `?`，两端归一到后者。
    // 可及名仍为空 —— 读屏不会把它念成某个具体的 Agent。
    renderIndex({
      axis: "project",
      rows: [row({ key: "a", agentSyncId: "" })],
    });

    const glyph = leadingGlyph();
    expect(glyph.textContent).toBe("?");
    expect(glyph.getAttribute("aria-label")).toBe("");
    expect(glyph.style.backgroundColor).toBe("var(--agent-1)");
  });

  it("项目组头用的是同一枚字形（不是另画一个 8px 色点），尺寸与桌面端同一档", () => {
    renderIndex({ axis: "project" });

    const glyph = within(groupHeaderFor("agentre-server")).getByTestId(
      "project-group-glyph",
    );
    // 组头与行首是同一枚字形，图标也必须是同一枚：组上画图标、行里退回首字的话，
    // 同一个项目在一屏之内长成两个样子。
    expect(glyph.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-code-xml",
    );
    expect(glyph.style.backgroundColor).toBe("var(--agent-11)");
    // 根项目那一档是 24px，与桌面端逐字同一条尺码阶梯（包里的 groupGlyphClassName）。
    // 本站此前一律 16px，同一个项目在两端因此长成两个大小。
    expect(glyph.className).toContain("size-6");
    // 组头文案照旧查得到（字形的首字不能把它糊成一段 "aagentre-server"）。
    expect(screen.getByText("agentre-server")).toBeTruthy();
  });

  it("Agent 组头是**那一枚头像**，不是一颗 8px 色点", () => {
    renderIndex({ axis: "agent" });

    // 与行首那一槽、与桌面端的 Agent 名单同一枚 AgentAvatar，只是尺寸档不同。
    const avatar = screen.getByTestId("agent-group-avatar");
    expect(avatar.style.backgroundColor).toBe("var(--agent-5)");
    expect(avatar.className).toContain("size-6");
  });
});

/**
 * 筛选跨轴一致（规格「索引的组成」筛选与搜索）：全部 / 运行中 / 等你处理。
 * 「等你处理」数的仍是 waitingForInput（决策 3 只改名字，不引入已读状态）。
 * 筛选生效时**只收窄行**，同时把一条都不剩的组头一起隐藏（决策 10 的同一条规则）。
 */
describe("统一会话索引：筛选 chips", () => {
  const running = row({
    key: "running",
    conversationId: "1",
    title: "跑着呢",
    lifecycleState: "running",
  });
  const waiting = row({
    key: "waiting",
    conversationId: "2",
    title: "等你批",
    lifecycleState: "running",
    waitingForInput: true,
    projectSyncId: "p-web",
  });
  const idle = row({
    key: "idle",
    conversationId: "3",
    title: "歇着",
    lifecycleState: "idle",
    projectSyncId: "p-web",
  });

  function renderFiltered() {
    return renderIndex({ axis: "project", rows: [running, waiting, idle] });
  }

  it("默认「全部」：三条都在，两个项目组头都在", () => {
    renderFiltered();

    expect(screen.getByText("跑着呢")).toBeTruthy();
    expect(screen.getByText("等你批")).toBeTruthy();
    expect(screen.getByText("歇着")).toBeTruthy();
    expect(screen.getByText("agentre-server")).toBeTruthy();
    expect(screen.getByText("agentre-web")).toBeTruthy();
  });

  it("点 chip 只把选中的那一档报给宿主，不在本地再筛一遍", () => {
    // 筛选搬去了服务端（规格 2026-08-19 决策 9）：留在这一层就只筛得到已加载的
    // 那些，「等你处理」会漏掉真在等的对话。这一层因此只报选择。
    const onFilterChange = vi.fn();
    renderIndex({
      axis: "project",
      rows: [running, waiting, idle],
      onFilterChange,
    });

    fireEvent.click(screen.getByTestId("filter-chip-running"));

    expect(onFilterChange).toHaveBeenCalledWith("running");
    // 宿主还没把新的 rows 送进来，行就一条都不该少——本地不抢着筛。
    expect(screen.getByText("跑着呢")).toBeTruthy();
    expect(screen.getByText("等你批")).toBeTruthy();
    expect(screen.getByText("歇着")).toBeTruthy();
  });

  it("当前选中哪一档由宿主说了算（aria-pressed 跟着 prop 走）", () => {
    renderIndex({ axis: "project", rows: [running], filter: "unread" });

    expect(
      screen.getByTestId("filter-chip-unread").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("filter-chip-all").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("「未读」chip 上的数来自宿主（服务端在完整集合上数的）", () => {
    renderIndex({ axis: "project", rows: [running], unreadCount: 12 });

    expect(screen.getByTestId("filter-chip-unread").textContent).toContain(
      "12",
    );
  });

  it("一条未读都没有时不摆一个 0（空徽标比没有徽标更吵）", () => {
    renderIndex({ axis: "project", rows: [running, idle], unreadCount: 0 });

    expect(screen.getByTestId("filter-chip-unread").textContent).not.toMatch(
      /\d/,
    );
  });

  it("筛完一条不剩时由空态承接，chips 仍在（否则回不去「全部」）", () => {
    renderIndex({ axis: "project", rows: [], filter: "running" });

    // 会话还在，只是这一档不收：空态不能说成「还没有对话」。
    expect(screen.getByTestId("session-index-empty").textContent).toContain(
      "Nothing in \u201cRunning\u201d",
    );
    expect(screen.getByTestId("filter-chip-all")).toBeTruthy();
  });

  it("宿主已按搜索收窄时，空的是这次搜索而不是账号（不谎报「还没有对话」）", () => {
    renderIndex({ axis: "project", rows: [], narrowed: true });

    expect(screen.getByTestId("session-index-empty").textContent).toContain(
      "No conversations match your search",
    );
  });
});

/**
 * 行上的 attention 记号。
 *
 * 判定与文案都走共享包（`computeAttention` / `reasonToDisplayStatus` /
 * `reasonToPillText`），与桌面端逐字同源：此前本站只有 chip 上那一个未读总数，看得见
 * 「有 3 条未读」却看不出是**哪三条**；而「上一轮跑挂了」在列表里干脆没有说法。
 *
 * 本站只保留自己的排布：记号摆在行尾、`<time>` 之后，语义时间标签不动。
 */
describe("统一会话索引：行上的 attention 记号", () => {
  const unreadRow = row({
    key: "unread",
    conversationId: "u1",
    title: "还没看",
    lifecycleState: "idle",
    updatedAt: 2_000,
    lastReadAt: 1_000,
  });
  const readRow = row({
    key: "read",
    conversationId: "r1",
    title: "看过了",
    lifecycleState: "idle",
    updatedAt: 1_000,
    lastReadAt: 2_000,
  });

  it("闲着但有新东西没看过的行带「未读」，读过的那条什么都不带", () => {
    renderIndex({ axis: "time", rows: [unreadRow, readRow] });

    expect(screen.getByTestId("row-attention-unread").textContent).toBe(
      "Unread",
    );
    expect(screen.queryByTestId("row-attention-read")).toBeNull();
  });

  it("从没打开过的行（没有已读时刻）也算未读", () => {
    renderIndex({
      axis: "time",
      rows: [
        row({
          key: "never",
          conversationId: "n1",
          title: "没开过",
          lifecycleState: "idle",
        }),
      ],
    });

    expect(screen.getByTestId("row-attention-never")).toBeTruthy();
  });

  it("还没保存进账号的行不算未读——账号里压根没有它", () => {
    renderIndex({
      axis: "time",
      rows: [
        row({
          key: "unsaved",
          conversationId: "s1",
          title: "机器上的",
          lifecycleState: "idle",
          saved: false,
          updatedAt: 2_000,
          lastReadAt: 0,
        }),
      ],
    });

    expect(screen.queryByTestId("row-attention-unsaved")).toBeNull();
  });

  it("跑挂过、还没看的那条说「出错」——列表里必须看得出上一轮的结局", () => {
    renderIndex({
      axis: "time",
      rows: [
        row({
          key: "failed",
          conversationId: "f1",
          title: "跑挂了",
          lifecycleState: "failed",
          updatedAt: 2_000,
          lastReadAt: 1_000,
        }),
      ],
    });

    expect(screen.getByTestId("row-attention-failed").textContent).toBe(
      "Error",
    );
  });

  it("有东西等你按时说「审批」，它盖过未读", () => {
    renderIndex({
      axis: "time",
      rows: [
        row({
          key: "waiting",
          conversationId: "w1",
          title: "等你批",
          lifecycleState: "running",
          waitingForInput: true,
          updatedAt: 2_000,
          lastReadAt: 1_000,
        }),
      ],
    });

    expect(screen.getByTestId("row-attention-waiting").textContent).toBe(
      "Approval",
    );
  });

  it("在跑的那条不摆记号——它自己那颗点已经在说这件事", () => {
    renderIndex({
      axis: "time",
      rows: [
        row({
          key: "running",
          conversationId: "g1",
          title: "跑着呢",
          lifecycleState: "running",
          updatedAt: 2_000,
          lastReadAt: 1_000,
        }),
      ],
    });

    expect(screen.queryByTestId("row-attention-running")).toBeNull();
  });

  it("记号的文案跟着语言走", async () => {
    renderIndex({ axis: "time", rows: [unreadRow] });
    expect(screen.getByTestId("row-attention-unread").textContent).toBe(
      "Unread",
    );

    await i18n.changeLanguage("zh-CN");
    expect(screen.getByTestId("row-attention-unread").textContent).toBe("未读");
  });
});

/**
 * 保存与删除（规格 2026-08-18 决策 5 / 6 / 11）。
 *
 * 「保存」只摆在**还没进账号**的那些行上——机器轴选中一台在线机器时列出的那些。
 * 已经在账号里的行行尾不摆任何动作（一列不会变的图标是纯噪声）。
 * 「删除」在行的右键菜单里，且只对已保存的行成立：没保存过的对话账号里没有它。
 */
describe("统一会话索引：保存与删除", () => {
  it("还没保存的行行尾是「保存」，按了把这一条报给宿主", () => {
    const onSave = vi.fn();
    renderIndex({
      axis: "machine",
      rows: [row({ key: "a", saved: false })],
      onSave,
    });

    fireEvent.click(screen.getByTestId("row-save-a"));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      key: "a",
      fingerprint: "fp-a",
      conversationId: "42",
    });
  });

  it("已经在账号里的行不摆保存（那一列不会变的图标是纯噪声）", () => {
    renderIndex({
      axis: "machine",
      rows: [row({ key: "a" })],
      onSave: vi.fn(),
    });

    expect(screen.queryByTestId("row-save-a")).toBeNull();
  });

  it("删除在行的右键菜单里：选中之后把这一条报给宿主（确认由宿主给）", async () => {
    const onDelete = vi.fn();
    renderIndex({ axis: "time", rows: [row({ key: "a" })], onDelete });

    fireEvent.contextMenu(screen.getByText("重构登录页"));
    const item = await screen.findByRole("menuitem", { name: "Delete" });
    fireEvent.click(item);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0]).toMatchObject({ key: "a" });
  });

  it("右键菜单里只有删除：重命名 / 在新标签页打开这两件事这一端做不了，不摆死项", async () => {
    renderIndex({ axis: "time", rows: [row({ key: "a" })], onDelete: vi.fn() });

    fireEvent.contextMenu(screen.getByText("重构登录页"));
    await screen.findByRole("menuitem", { name: "Delete" });

    expect(screen.getAllByRole("menuitem").length).toBe(1);
  });

  it("还没保存的行没有删除：账号里根本没有它", async () => {
    renderIndex({
      axis: "machine",
      rows: [row({ key: "a", saved: false })],
      onDelete: vi.fn(),
      onSave: vi.fn(),
    });

    fireEvent.contextMenu(screen.getByText("重构登录页"));

    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

/**
 * 删除确认（决策 6 / 16）。一次确认，文案按执行机在线与否分成两套；执行端是
 * 桌面端时必须说清楚被删掉的是**那台电脑上这条对话本身**，不是一份执行记录。
 */
describe("删除确认弹层", () => {
  function renderDialog(
    props: Partial<React.ComponentProps<typeof DeleteSessionDialog>>,
  ) {
    const onConfirm = vi.fn();
    render(
      <ThemeProvider>
        <DeleteSessionDialog
          open
          onOpenChange={vi.fn()}
          machineName="Studio box"
          machineOnline
          machineKind="agentred"
          onConfirm={onConfirm}
          {...props}
        />
      </ThemeProvider>,
    );
    return { onConfirm };
  }

  it("机器在线：说清两边一起清掉", () => {
    renderDialog({});

    expect(
      screen.getByRole("heading", { name: "Delete this conversation?" }),
    ).toBeTruthy();
    const body = screen.getByTestId("delete-session-body").textContent ?? "";
    expect(body).toContain("Studio box");
    expect(body).toContain("also deleted from");
    expect(body).toContain("cannot be undone");
  });

  it("机器离线：账号那份当场清掉，那台机器回来时补删——不留「已删除但还在」", () => {
    renderDialog({ machineOnline: false, machineName: "Old laptop" });

    const body = screen.getByTestId("delete-session-body").textContent ?? "";
    expect(body).toContain("Old laptop");
    expect(body).toContain("is offline");
    expect(body).toContain("next time it comes online");
  });

  it("执行端是桌面端：说明那里删掉的是那台电脑上这条对话本身（决策 16 的已知代价）", () => {
    renderDialog({ machineKind: "desktop", machineName: "Work MacBook" });

    const body = screen.getByTestId("delete-session-body").textContent ?? "";
    expect(body).toContain("Work MacBook");
    expect(body).toContain("the conversation itself on that computer");
    expect(body).not.toContain("execution log");
  });

  it("桌面端 + 离线：两件事都说，不因为离线就少说桌面端那一句", () => {
    renderDialog({
      machineKind: "desktop",
      machineOnline: false,
      machineName: "Work MacBook",
    });

    const body = screen.getByTestId("delete-session-body").textContent ?? "";
    expect(body).toContain("next time it comes online");
    expect(body).toContain("the conversation itself on that computer");
  });

  it("认不出执行端那台机器时不编在线与否，只说会在它连上时一并清掉", () => {
    renderDialog({ machineName: undefined, machineKind: undefined });

    const body = screen.getByTestId("delete-session-body").textContent ?? "";
    expect(body).toContain("next time it connects");
  });

  it("确认按钮是危险动作，按了才真的删；取消不删", () => {
    const { onConfirm } = renderDialog({});

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

/**
 * ↑↓ + Enter（任务 3 随 ChatList 一起丢掉的，没有替代物）。
 * 光标移的是**真焦点**：焦点落在行链接上，长列表因此由浏览器自己滚进视口，
 * Enter 才有一个明确的「当前这条」可开。
 */
describe("统一会话索引：↑↓ 键盘导航 + Enter 打开", () => {
  const first = row({ key: "a", conversationId: "42", title: "第一条" });
  const second = row({ key: "b", conversationId: "43", title: "第二条" });

  it("↑↓ 在行之间移动焦点，越界不回绕", () => {
    renderIndex({ axis: "time", rows: [first, second] });
    const nav = screen.getByTestId("session-index-nav");

    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-nav-target")).toBe("a");
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-nav-target")).toBe("b");
    // 末尾再往下不回绕到第一条。
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-nav-target")).toBe("b");
    fireEvent.keyDown(nav, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("data-nav-target")).toBe("a");
  });

  it("Enter 打开当前这条：桌面交给宿主的右栏（onSelect）", () => {
    const onSelect = vi.fn();
    renderIndex({ axis: "time", rows: [first, second], onSelect });
    const nav = screen.getByTestId("session-index-nav");

    fireEvent.keyDown(nav, { key: "ArrowDown" });
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    fireEvent.keyDown(nav, { key: "Enter" });

    // 整行交出去（不是 deviceId + 身份两个值）：宿主要用行上的发起端指纹
    // 去取镜像里的转录，与保存 / 删除同一条口径。
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      key: "b",
      conversationId: "43",
    });
  });

  it("没有右栏（移动端不传 onSelect）时 Enter 走真实路由", () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/chat"]}>
          <Routes>
            <Route
              path="/chat"
              element={
                <SessionIndex
                  axis="time"
                  onAxisChange={vi.fn()}
                  rows={[first]}
                  projects={projects}
                  agents={agents}
                  machines={machines}
                  filter="all"
                  onFilterChange={vi.fn()}
                  sessionPath={(deviceId, conversationId) =>
                    `/devices/${deviceId}/sessions/${conversationId}`
                  }
                />
              }
            />
            <Route path="/devices/20/sessions/42" element={<p>detail-42</p>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );

    fireEvent.keyDown(screen.getByTestId("session-index-nav"), {
      key: "ArrowDown",
    });
    fireEvent.keyDown(screen.getByTestId("session-index-nav"), {
      key: "Enter",
    });

    expect(screen.getByText("detail-42")).toBeTruthy();
  });

  it("没有选中任何一条时 Enter 什么都不做（不拿第一条冒充用户的选择）", () => {
    const onSelect = vi.fn();
    renderIndex({ axis: "time", rows: [first, second], onSelect });

    fireEvent.keyDown(screen.getByTestId("session-index-nav"), {
      key: "Enter",
    });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("行以外的可交互元素上按 Enter 不被抢走（行尾的保存仍是它自己的动作）", () => {
    const onSelect = vi.fn();
    const onSave = vi.fn();
    renderIndex({
      axis: "time",
      rows: [first, { ...second, saved: false }],
      onSelect,
      onSave,
    });
    const nav = screen.getByTestId("session-index-nav");

    fireEvent.keyDown(nav, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("row-save-b"), { key: "Enter" });

    expect(onSelect).not.toHaveBeenCalled();
  });
});

/**
 * 组的收放与溢出（规格 2026-08-19 决策 3 / 4 / 5 / 6）。
 *
 * 三样都用共享包的 `SessionGroup`：折叠 + `persistenceKey`、`totalSessions` 那个
 * 「查看全部 N 个会话」、以及收起时仍露出来的 attention 气泡。这一层只负责把
 * 每组的真数与翻页回调接上去——N 是服务端在完整集合上数出来的，不是已加载的条数。
 */
describe("统一会话索引：组的收放与「查看全部 N」", () => {
  const rows = [
    row({
      key: "a",
      conversationId: "1",
      title: "第一条",
      projectSyncId: "p-server",
    }),
    row({
      key: "b",
      conversationId: "2",
      title: "等你批",
      projectSyncId: "p-server",
      waitingForInput: true,
    }),
  ];

  it("组头可收可放：收起后组内容对读屏与键盘都不可达", () => {
    const { container } = renderIndex({ axis: "project", rows });

    const content = container.querySelector(
      '[data-slot="agent-group-content"]',
    );
    expect(content?.getAttribute("aria-hidden")).toBe("false");

    fireEvent.click(groupToggleFor("agentre-server"));

    expect(
      container
        .querySelector('[data-slot="agent-group-content"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("收起来的组头上仍看得见「等你处理」那条（收起不等于把提醒也收掉）", () => {
    const { container } = renderIndex({
      axis: "project",
      rows: [
        ...rows,
        // 读过的闲会话没有任何理由需要你，它才是不该冒出来的那种。
        row({
          key: "quiet",
          conversationId: "3",
          title: "读过的闲会话",
          projectSyncId: "p-server",
          lifecycleState: "idle",
          updatedAt: 1_000,
          lastReadAt: 2_000,
        }),
      ],
    });

    fireEvent.click(groupToggleFor("agentre-server"));

    const bubble = container.querySelector(
      '[data-slot="agent-attention-bubble"]',
    );
    expect(bubble?.textContent).toContain("等你批");
    expect(bubble?.textContent).not.toContain("读过的闲会话");
  });

  it("跑挂过的那条也冒出来——气泡认的是 attention 判定，不只是「等你按」", () => {
    // 此前这里写死 `r.waitingForInput`：一条上一轮跑挂的对话在收起的组里彻底消失。
    // 判定改走共享包之后，出错与未读同样是「需要你」的理由（与桌面端同一套词汇）。
    const { container } = renderIndex({
      axis: "project",
      rows: [
        row({
          key: "boom",
          conversationId: "b1",
          title: "跑挂了",
          lifecycleState: "failed",
          updatedAt: 2_000,
          lastReadAt: 1_000,
        }),
        row({
          key: "quiet",
          conversationId: "q1",
          title: "读过的闲会话",
          lifecycleState: "idle",
          updatedAt: 1_000,
          lastReadAt: 2_000,
        }),
      ],
    });

    fireEvent.click(groupToggleFor("agentre-server"));

    const bubble = container.querySelector(
      '[data-slot="agent-attention-bubble"]',
    );
    expect(bubble?.textContent).toContain("跑挂了");
    expect(bubble?.textContent).not.toContain("读过的闲会话");
  });

  it("真数大于已列条数时出现「查看全部 N」，N 用服务端给的那个数", () => {
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage: vi.fn(),
    });

    expect(screen.getByText("View all 9 sessions")).toBeTruthy();
  });

  it("这一组已经列全了就不摆溢出入口", () => {
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 2 },
      loadGroupPage: vi.fn(),
    });

    expect(screen.queryByText(/View all/)).toBeNull();
  });

  /**
   * 弹层的朝向此前是写死的「往下开」：Radix 的碰撞规避确实开着，但弹层的高度也写死
   * 在 `60vh`，于是触发器落在视口中段时**两边都放不下**，flip 只能挑一个少溢出的，
   * 溢出的那一截连同内部滚动区一起被推到视口外，够不着。所以朝向要按触发器在视口里
   * 的位置定，高度要收在 Radix 报的可用高度里。
   */
  /**
   * jsdom 不排版：`documentElement.clientWidth/Height` 恒为 0，而 floating-ui 正是
   * 按它算视口的。不摆一个真视口，Radix 的碰撞规避会把每个朝向都算成「全溢出」，
   * 挑出来的边与我们请求的那一边无关——量朝向就成了掷骰子。
   */
  function stubViewport(width: number, height: number) {
    const html = document.documentElement;
    const original = {
      clientWidth: Object.getOwnPropertyDescriptor(html, "clientWidth"),
      clientHeight: Object.getOwnPropertyDescriptor(html, "clientHeight"),
    };
    Object.defineProperty(html, "clientWidth", {
      configurable: true,
      value: width,
    });
    Object.defineProperty(html, "clientHeight", {
      configurable: true,
      value: height,
    });
    return () => {
      if (original.clientWidth) {
        Object.defineProperty(html, "clientWidth", original.clientWidth);
      } else {
        delete (html as unknown as Record<string, unknown>).clientWidth;
      }
      if (original.clientHeight) {
        Object.defineProperty(html, "clientHeight", original.clientHeight);
      } else {
        delete (html as unknown as Record<string, unknown>).clientHeight;
      }
    };
  }

  function stubTriggerRect(el: HTMLElement, top: number, bottom: number) {
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom,
        left: 0,
        right: 160,
        width: 160,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  function overflowTriggerAt(top: number, bottom: number) {
    const el = screen
      .getByText("View all 9 sessions")
      .closest("button") as HTMLButtonElement;
    // jsdom 不排版，触发器的矩形只能自己摆——这条用例量的正是「按矩形选边」。
    stubTriggerRect(el, top, bottom);
    return el;
  }

  it("触发器贴着视口下沿时弹层朝上开", async () => {
    const restore = stubViewport(1024, 768);
    const loadGroupPage = vi.fn(async () => ({
      rows: [],
      cursor: null,
      hasMore: false,
    }));
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage,
    });

    fireEvent.click(overflowTriggerAt(708, 728));

    const content = await screen.findByTestId("group-overflow");
    expect(content.getAttribute("data-side")).toBe("top");
    restore();
  });

  it("触发器在视口上半时弹层照旧朝下开", async () => {
    const restore = stubViewport(1024, 768);
    const loadGroupPage = vi.fn(async () => ({
      rows: [],
      cursor: null,
      hasMore: false,
    }));
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage,
    });

    fireEvent.click(overflowTriggerAt(40, 60));

    const content = await screen.findByTestId("group-overflow");
    expect(content.getAttribute("data-side")).toBe("bottom");
    restore();
  });

  it("弹层的高度收在 Radix 报的可用高度里，不再写死 60vh", async () => {
    const loadGroupPage = vi.fn(async () => ({
      rows: [],
      cursor: null,
      hasMore: false,
    }));
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage,
    });

    fireEvent.click(overflowTriggerAt(40, 60));

    const content = await screen.findByTestId("group-overflow");
    // 写死 60vh 时溢出的那一截连同内部滚动区一起在视口外，够不着；跟着可用高度走
    // 才能既不被裁掉、又把翻页按钮留在能点到的地方。
    expect(content.className).toContain(
      "var(--radix-popover-content-available-height)",
    );
  });

  it("弹层首屏不是一块空白：第一页回来之前先摆骨架", async () => {
    // 第一页一直在飞：这条用例量的就是点开之后到第一页落地之间那段窗口。
    const loadGroupPage = vi.fn(() => new Promise<never>(() => {}));
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage,
    });

    fireEvent.click(screen.getByText("View all 9 sessions"));

    // 首屏三个分支此前全落空（loading=true、hasMore=false、rows 为空），
    // 用户点开得到的是一个 360px 宽的空白浮层。
    const holder = await screen.findByTestId("group-overflow-loading");
    expect(holder.getAttribute("aria-busy")).toBe("true");
    expect(within(holder).getByTestId("session-list-skeleton")).toBeTruthy();
  });

  it("点「查看全部 N」按这一组的 scope 翻页，列出翻回来的行", async () => {
    const loadGroupPage = vi.fn(async () => ({
      rows: [row({ key: "c", conversationId: "3", title: "第三条" })],
      cursor: null,
      hasMore: false,
    }));
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage,
    });

    fireEvent.click(screen.getByText("View all 9 sessions"));

    await waitFor(() =>
      expect(loadGroupPage).toHaveBeenCalledWith("project:p-server", null),
    );
    expect(await screen.findByText("第三条")).toBeTruthy();
  });

  /**
   * 弹层是按 scope 现翻的，翻回来可能是空的（打开的那一刻宿主的搜索/筛选又收窄了，
   * 或者这一组刚被清空）。它此前借了**页面级**空态那句「没有匹配这次搜索的对话」
   * ——可这里未必在搜索。借来的键还有更实的风险：它属于别人，别人改名/删键时这里
   * 不报错，只在运行时把裸键号印到界面上。所以这一句必须是它自己的。
   */
  it("弹层翻回来是空的：说一句它自己的话，不是页面级空态那句，更不是裸键号", async () => {
    const loadGroupPage = vi.fn(async () => ({
      rows: [],
      cursor: null,
      hasMore: false,
    }));
    renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage,
    });

    fireEvent.click(screen.getByText("View all 9 sessions"));
    await waitFor(() => expect(loadGroupPage).toHaveBeenCalled());

    const empty = await screen.findByTestId("group-overflow-empty");
    expect(empty.textContent).not.toContain("sessionIndex.");
    expect(empty.textContent).not.toContain("match your search");
    expect(empty.textContent?.trim()).toBeTruthy();
  });

  it("收起的组里的行不在 ↑↓ 的路线上（规格 2026-08-19「组怎么收怎么放」可达性）", () => {
    renderIndex({
      axis: "project",
      rows: [
        ...rows,
        row({
          key: "c",
          conversationId: "3",
          title: "另一个项目",
          projectSyncId: "p-web",
        }),
      ],
    });

    fireEvent.click(groupToggleFor("agentre-server"));
    fireEvent.keyDown(screen.getByTestId("session-index-nav"), {
      key: "ArrowDown",
    });

    // 收起的组里那两行看不见也走不到：第一次 ↓ 就该落在下一个组的第一行上，
    // 而不是把焦点送进一个 aria-hidden 的区域里。
    expect(document.activeElement?.getAttribute("data-nav-target")).toBe("c");
  });

  it("折叠状态记在本地：重新挂载还是收起的", () => {
    const first = renderIndex({ axis: "project", rows });
    fireEvent.click(groupToggleFor("agentre-server"));
    first.unmount();

    const { container } = renderIndex({ axis: "project", rows });
    expect(
      container
        .querySelector('[data-slot="agent-group-content"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});

/**
 * 索引列与桌面端对齐的四处（2026-08-20 对话页 UI/UX 改版）。
 *
 * 前三处是**同一类问题**：屏幕上有东西可做，但没有任何东西说它在那里 ——
 * 组收得起来却没有箭头、兜底组用一个灰方块顶着、机器轴上「把这台机器上的对话
 * 收进账号」藏在两层菜单之后。第四处是次序：「查看全部 N」被 wiring 顶到了行
 * 之前，读起来像是这一组的开头而不是它的末尾。
 */
describe("统一会话索引：与桌面端对齐的组头与溢出入口", () => {
  const rows = [
    row({
      key: "a",
      conversationId: "1",
      title: "第一条",
      projectSyncId: "p-server",
    }),
    row({
      key: "b",
      conversationId: "2",
      title: "第二条",
      projectSyncId: "p-server",
    }),
  ];

  it("组头摆一枚会转的箭头：收起来的时候它转 90°（收放这件事得看得见）", () => {
    renderIndex({ axis: "project", rows });

    // SVG 元素的 .className 是 SVGAnimatedString，不是字符串——读 class 属性。
    const chevron = () =>
      within(groupHeaderFor("agentre-server")).getByTestId(
        "group-header-chevron",
      );
    expect(chevron().getAttribute("class")).not.toContain("-rotate-90");

    fireEvent.click(groupToggleFor("agentre-server"));

    expect(chevron().getAttribute("class")).toContain("-rotate-90");
  });

  // 「导入本地会话…」这一条挂在组头上（规格 2026-08-26 决策 13）：磁盘上的旧 CLI
  // 会话经**那台机器**导进账号，入口按轴预填自己那一维。
  it("机器组头上有「导入本地会话…」，点开即锁定那台机器", async () => {
    renderIndex({ axis: "machine", rows: [row({ key: "m", deviceId: 20 })] });

    const trigger = within(groupHeaderFor("Studio box")).getByTestId(
      "import-menu-device-20-trigger",
    );
    openMenu(trigger);

    expect(
      (await screen.findByTestId("import-menu-device-20-item")).textContent,
    ).toContain("Import local session");
  });

  it("兜底组叫「随手对话」，字形是「对话」而不是一个项目字形（它是正当去处，不是分类失败的残留）", () => {
    renderIndex({
      axis: "project",
      rows: [row({ key: "f", conversationId: "5", projectSyncId: undefined })],
    });

    expect(screen.getByText("Quick chats")).toBeTruthy();
    const header = groupHeaderFor("Quick chats");
    // 与桌面端同一件：24px 的中性面里放一枚「对话」图标。本站此前是一枚光秃的
    // 14px 图标，于是这一组的名字起始 x 与它的邻居对不齐。
    expect(header.querySelector(".bg-secondary")?.className).toContain(
      "size-6",
    );
    // 项目字形（首字方块）不该出现在这一组上。
    expect(within(header).queryByTestId("project-group-glyph")).toBeNull();
  });

  it("「查看全部 N」摆在这一组最后一行**之后**，不是行之前", () => {
    const { container } = renderIndex({
      axis: "project",
      rows,
      groupTotals: { "p-server": 9 },
      loadGroupPage: vi.fn(),
    });

    const viewAll = screen.getByText("View all 9 sessions");
    const lastRow = screen.getByText("第二条");
    // compareDocumentPosition：FOLLOWING(4) = viewAll 在 lastRow 之后。
    expect(
      lastRow.compareDocumentPosition(viewAll) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="group-p-server"]'),
    ).toBeTruthy();
  });

  /**
   * 规格 2026-08-21 决策 3：机器轴上**每台**能跑会话的机器都出一组。共享包的
   * `buildAxisGroups` 只给有行的机器出组（「有会话的机器才出现」），而「离线就说
   * 离线」需要一个组头去承载——空组因此由本站在投影之后补齐。
   */
  it("机器轴上每台机器都出一组，含零会话的与离线的", () => {
    renderIndex({
      axis: "machine",
      rows: [
        row({
          key: "on",
          conversationId: "1",
          deviceId: 20,
          fingerprint: "fp-on",
        }),
      ],
    });

    // 有会话的那台照旧。
    expect(screen.getByTestId("group-device-20")).toBeTruthy();
    // 一条会话都没有的离线那台也在，并如实标出离线。
    expect(screen.getByTestId("group-device-21")).toBeTruthy();
    expect(screen.getByTestId("group-offline-device-21")).toBeTruthy();
  });

  /**
   * 补齐空组要**沿用**共享包排机器那条规则，而不是另立一条：同名的两台机器包里
   * 按设备标识升序收尾（`axis-groups.js` 的 `a.deviceId - b.deviceId`）。这里按组
   * 键的字符串收尾的话，`device-10` 会排到 `device-9` 前面——同一个名字的两台机器
   * 在这一页与包给出的次序相反，而两者说的是同一件事。
   */
  it("同名的两台机器：按设备标识升序，与共享包同一条收尾规则", () => {
    renderIndex({
      axis: "machine",
      rows: [row({ key: "a", deviceId: 10, fingerprint: "fp-a" })],
      machines: [
        { deviceId: 10, name: "MacBook Pro", online: true },
        { deviceId: 9, name: "MacBook Pro", online: true },
      ],
    });

    const order = [
      ...document.querySelectorAll("[data-testid^='group-device-']"),
    ].map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["group-device-9", "group-device-10"]);
  });

  it("在线但一条会话都没有的机器：组里给一句说明；离线的那台不给（原因在组头上）", () => {
    renderIndex({ axis: "machine", rows: [] });

    const online = screen.getByTestId("group-device-20");
    expect(
      within(online).getByText("No conversations on this machine yet."),
    ).toBeTruthy();
    const offline = screen.getByTestId("group-device-21");
    expect(
      within(offline).queryByText("No conversations on this machine yet."),
    ).toBeNull();
  });

  it("机器轴一条行都没有时不印页面级空态：每台机器自己那句已经说完了", () => {
    renderIndex({ axis: "machine", rows: [] });

    expect(screen.queryByTestId("session-index-empty")).toBeNull();
  });

  /**
   * 但「每台机器自己会说」只在**真有机器**时成立。账号下一台能跑会话的机器都没有
   * （会话全是浏览器发起的，或者机器已经从账号里摘掉）时，这一轴上一个组头都出不来
   * ——这时不说话就是一块无言的空白，读者分不出它是空的还是坏的。索引在任何一个轴上
   * 都要如实说一句（docs/design.md「honest empty states」）。
   */
  it("机器轴上一台机器都没有：没有组头去说话，页面级空态照旧顶上", () => {
    renderIndex({ axis: "machine", rows: [], machines: [] });

    expect(screen.getByTestId("session-index-empty").textContent).toContain(
      "No conversations yet.",
    );
  });

  /**
   * 规格 2026-08-21 决策 6：N 台机器各有各的状态，一条页面级横幅说不了 N 件事，
   * 所以状态说在**各自的组头**上。判据不只靠颜色：与「离线」同形，是可见文字。
   */
  it("在线但还没交出清单的机器：组头标「连接中」", () => {
    renderIndex({
      axis: "machine",
      rows: [],
      machineStates: { 20: "connecting" },
    });

    expect(screen.getByTestId("group-state-device-20").textContent).toBe(
      "Connecting",
    );
    // 离线那台不在 machineStates 里：它的状态由 machines 上的 online 说。
    expect(screen.getByTestId("group-offline-device-21")).toBeTruthy();
    expect(screen.queryByTestId("group-state-device-21")).toBeNull();
  });

  it("连上了却取不回清单：组头标「连不上」，与「离线」是两回事", () => {
    renderIndex({
      axis: "machine",
      rows: [],
      machineStates: { 20: "unreachable" },
    });

    expect(screen.getByTestId("group-state-device-20").textContent).toBe(
      "Unreachable",
    );
  });

  it("已经交出清单的机器：组头上什么也不摆（正常不用说）", () => {
    renderIndex({
      axis: "machine",
      rows: [],
      machineStates: { 20: "connected" },
    });

    expect(screen.queryByTestId("group-state-device-20")).toBeNull();
  });

  it("机器轴上搜索收窄到一条不剩：组头留着，页面级空态如实说是这次搜索不收", () => {
    renderIndex({ axis: "machine", rows: [], narrowed: true });

    expect(screen.getByTestId("group-device-20")).toBeTruthy();
    // 收窄之后「这台机器上还没有对话」是假话——它们还在，只是这次搜索不收。
    expect(
      screen.queryByText("No conversations on this machine yet."),
    ).toBeNull();
    expect(screen.getByTestId("session-index-empty").textContent).toContain(
      "No conversations match your search",
    );
  });
});

/**
 * 空态与「加载更多」失败各自带一条出路（规格 2026-08-21 决策 12 / 13）。
 *
 * 三种空态此前都是一行 14px 灰字，靠左，**没有回到「全部」的路**——chips 还在，
 * 但没人告诉你按哪个。而「这一页没能取回来」用的是 `status-error`，横幅那边用的
 * 是 `destructive`：同一个「出错了」两个 token。
 */
describe("会话索引：空态与失败的出路", () => {
  const noop = () => {};

  function renderIndex(
    props: Partial<React.ComponentProps<typeof SessionIndex>> = {},
  ) {
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionIndex
            axis="time"
            onAxisChange={noop}
            rows={[]}
            projects={[]}
            agents={[]}
            machines={[]}
            filter="all"
            onFilterChange={noop}
            unreadCount={0}
            sessionPath={(d, s) => `/devices/${d}/sessions/${s}`}
            {...props}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("筛选筛空了：标题点名是**哪一档**空了,正文说账号里还有多少条", () => {
    const onFilterChange = vi.fn();
    renderIndex({ filter: "waiting", onFilterChange, accountTotal: 24 });

    const empty = screen.getByTestId("session-index-empty");
    // 「这一档」是黑话：读者眼前只有 chip 上那几个字。空态要用同一个词回指。
    expect(empty.textContent).toContain("Waiting for you");
    expect(empty.textContent).toContain("24");
    within(empty).getByTestId("empty-action").click();
    expect(onFilterChange).toHaveBeenCalledWith("all");
  });

  /**
   * accountTotal 是可选的：宿主没算出来时它是 undefined，而不是 0。此前两者被
   * `?? 0` 揉成一个，于是「不知道有多少条」被当成「一条都没有」，回「全部」的按钮
   * 一起被吞掉——用户筛进一个空档就出不来了。不知道总数只是少说一句，不是没有出路。
   */
  it("账号总数没算出来时照样给回「全部」的路,只是不报数", () => {
    const onFilterChange = vi.fn();
    renderIndex({ filter: "running", onFilterChange });

    const empty = screen.getByTestId("session-index-empty");
    expect(empty.textContent).toContain("Running");
    within(empty).getByTestId("empty-action").click();
    expect(onFilterChange).toHaveBeenCalledWith("all");
  });

  it("账号里确实一条都没有：不摆一个通向另一块空白的按钮", () => {
    renderIndex({ filter: "running", accountTotal: 0 });

    expect(
      within(screen.getByTestId("session-index-empty")).queryByTestId(
        "empty-action",
      ),
    ).toBeNull();
  });

  it("搜索搜空了：给的是「清除搜索」,不是「看全部」——它们是两件事", () => {
    const onClearSearch = vi.fn();
    renderIndex({ narrowed: true, onClearSearch });

    const empty = screen.getByTestId("session-index-empty");
    expect(empty.textContent).toContain("No conversations match your search");
    within(empty).getByTestId("empty-action").click();
    expect(onClearSearch).toHaveBeenCalledOnce();
  });

  it("接不住那个动作就不摆一个按下去什么都不发生的按钮", () => {
    renderIndex({ narrowed: true });
    expect(
      within(screen.getByTestId("session-index-empty")).queryByTestId(
        "empty-action",
      ),
    ).toBeNull();
  });

  it("加载更多失败：图标 + 一句 + 重试在同一行,红色与横幅同源", () => {
    const onLoadMore = vi.fn();
    renderIndex({ loadMoreFailed: true, onLoadMore });

    const bar = screen.getByTestId("index-load-more-failed");
    expect(bar.getAttribute("role")).toBe("alert");
    // 「出错了」在全站只有一个 token 家族（决策 13）：status-error 留给会话自身
    // 的状态点，不再兼职表达「这次操作失败了」。
    expect(bar.className).toContain("destructive");
    expect(bar.className).not.toContain("status-error");
    within(bar).getByTestId("index-load-more").click();
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});

/**
 * 机器轴组头的三档表达（规格 2026-08-21 决策 9 / 10 / 11）。
 *
 * 改版之后每台机器都有自己的组头、状态说在各自头上——方向是对的，剩下的是这一层
 * 的表达：`连接中`（在动）、`连不上`（出问题了）、`离线`（不在）此前共用一枚
 * `bg-muted` 灰标签，10px，一模一样。而 `连接中` 是一枚**静止**的标签，读起来像
 * 终态；三档里只有 `连不上` 能靠用户动作改变，整条轴上却没有任何重试入口。
 */
describe("会话索引：机器轴组头的三档", () => {
  const NOW = 1754000000000;

  it("连接中：组头是转着的,组是 busy,组里摆骨架而不是「还没有对话」", () => {
    renderIndex({
      axis: "machine",
      rows: [],
      machineStates: { 20: "connecting" },
    });

    const head = screen.getByTestId("group-state-device-20");
    // 可见文字仍在（sr-only）：状态不能只剩一个转圈的图形。
    expect(head.textContent).toBe("Connecting");
    expect(head.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const group = screen.getByTestId("group-device-20");
    expect(group.getAttribute("aria-busy")).toBe("true");
    expect(within(group).getByTestId("group-skeleton")).toBeTruthy();
    // 「这台机器上还没有对话」是个结论，而这一组还没答上来。
    expect(
      within(group).queryByText("No conversations on this machine yet."),
    ).toBeNull();
  });

  it("连不上：升到 status-waiting,并在这台机器自己的组头上长出重试", () => {
    const onRetryMachine = vi.fn();
    renderIndex({
      axis: "machine",
      rows: [],
      machineStates: { 20: "unreachable" },
      onRetryMachine,
    });

    // 三档里只有它是「出问题了」，颜色要与「在动」「不在」分开。
    expect(screen.getByTestId("group-state-device-20").className).toContain(
      "status-waiting",
    );
    screen.getByTestId("group-retry-device-20").click();
    expect(onRetryMachine).toHaveBeenCalledWith(20);
  });

  it("离线：保持中性灰,带上最后在线,而且不给重试——等的是那台机器,不是这一次请求", () => {
    vi.setSystemTime(NOW);
    renderIndex({
      axis: "machine",
      rows: [],
      machineNotes: { 21: { lastSeenAt: NOW - 3 * 3600_000 } },
      onRetryMachine: vi.fn(),
    });

    const tag = screen.getByTestId("group-offline-device-21");
    expect(tag.textContent).toContain(
      formatRelativeTime(NOW - 3 * 3600_000, "en", NOW),
    );
    expect(tag.className).not.toContain("status-waiting");
    expect(screen.queryByTestId("group-retry-device-21")).toBeNull();
  });

  it("连上了就摆这一组有几条,0 也摆——「还没有对话」与「还没答上来」据此分得开", () => {
    renderIndex({
      axis: "machine",
      rows: [],
      machineStates: { 20: "connected" },
    });

    expect(screen.getByTestId("group-count-device-20").textContent).toBe("0");
  });
});

/**
 * 选中高亮说的是「右栏此刻开着哪一条」，因此它归宿主（selectedKey）。
 * 键盘光标是另一回事：↑↓ 走到哪一行只是把焦点挪过去，不代表那一条被打开了。
 * 两者混作一谈时，点过一行之后光标就把高亮钉死在那一行上——宿主之后无论把右栏
 * 换成哪一条（新开的对话、删掉当前这条之后收起右栏），左栏都还标着上一条。
 */
describe("统一会话索引：高亮说的是宿主开着的那一条", () => {
  const first = row({ key: "a", conversationId: "42", title: "第一条" });
  const second = row({ key: "b", conversationId: "43", title: "第二条" });

  function tree(selectedKey: string | null) {
    return (
      <ThemeProvider>
        <MemoryRouter>
          <SessionIndex
            axis="time"
            onAxisChange={vi.fn()}
            rows={[first, second]}
            projects={projects}
            agents={agents}
            machines={machines}
            filter="all"
            onFilterChange={vi.fn()}
            selectedKey={selectedKey}
            onSelect={vi.fn()}
            sessionPath={(deviceId, conversationId) =>
              `/devices/${deviceId}/sessions/${conversationId}`
            }
          />
        </MemoryRouter>
      </ThemeProvider>
    );
  }

  /** 行链接（共享包把 aria-current 放在它身上）。 */
  function rowLink(key: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(
      `[data-nav-target="${key}"]`,
    );
    if (!el) throw new Error("没有这一行：" + key);
    return el;
  }

  it("宿主把选中换到另一条：高亮跟着走，不钉在点过的那一行上", () => {
    const { rerender } = render(tree("a"));
    // 点开第一条（这一步同时把键盘光标挪了过来）。
    fireEvent.click(rowLink("a"));
    expect(rowLink("a").getAttribute("aria-current")).toBe("true");

    // 宿主换了右栏：新开的一条对话进来了。
    rerender(tree("b"));

    expect(rowLink("b").getAttribute("aria-current")).toBe("true");
    expect(rowLink("a").getAttribute("aria-current")).toBeNull();
  });

  it("宿主收起右栏（没有任何一条开着）：左栏一条都不标", () => {
    const { rerender } = render(tree("a"));
    fireEvent.click(rowLink("a"));

    rerender(tree(null));

    expect(rowLink("a").getAttribute("aria-current")).toBeNull();
    expect(rowLink("b").getAttribute("aria-current")).toBeNull();
  });

  it("↑↓ 只移焦点：走过的那一行不冒充「正开着」", () => {
    render(tree(null));
    const nav = screen.getByTestId("session-index-nav");

    fireEvent.keyDown(nav, { key: "ArrowDown" });

    expect(document.activeElement?.getAttribute("data-nav-target")).toBe("a");
    expect(rowLink("a").getAttribute("aria-current")).toBeNull();
  });
});
