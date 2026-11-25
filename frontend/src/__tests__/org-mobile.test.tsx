import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import * as accountChannel from "@/lib/accountChannel";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Org from "@/pages/Org";
import type { OrgChartResponse } from "@/pages/org/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);

const chart: OrgChartResponse = {
  departments: [{ sync_id: "dept-eng", name: "Engineering", sort_order: 0 }],
  agents: [
    {
      sync_id: "agent-alice",
      name: "Alice",
      department_sync_id: "dept-eng",
      sort_order: 0,
      exec_targets: [],
    },
  ],
};

const originalMatchMedia = window.matchMedia;

/** 把视口 mock 成移动端（useIsMobile 读的就是这条 query）。 */
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

function renderOrgAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <Routes>
          {/* 与 App.tsx 同一条可选段路由：分成两条会让「选中 / 取消选中」把页面
              卸载重挂（useOrgData 重拉一遍 + 闪 loading），那不是产品里的行为。 */}
          <Route path="/org/:kind?/:syncId?" element={<Org />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedStartChannel.mockReset();
  mockedStartChannel.mockReturnValue({ stop: vi.fn() });
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/workspace/org" && (!init || init.method === undefined))
      return chart;
    if (path === "/v1/workspace/org/backends") return { backends: [] };
    if (init?.method === "POST") return { sync_id: "new-sync-id", version: 1 };
    throw new Error(`unexpected request: ${path}`);
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

/**
 * 移动形态（mockup `11-mobile.png`）：索引升整页，点一行下钻到详情页，详情头部带
 * 返回。窄屏没有并排的空间——桌面那套「320px 索引 + 详情」并排在 390px 上会把详情
 * 挤到只剩几十像素。
 */
describe("组织面移动形态：索引升整页，详情下钻", () => {
  it("移动端不并排：没选中时只有索引，索引不再是固定 320px 的一列", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const layout = screen.getByTestId("org-layout");
    expect(layout.className).not.toContain("flex-row");
    expect(screen.queryByTestId("org-detail-col")).toBeNull();

    const indexCol = screen.getByTestId("org-index-col");
    expect(indexCol.className).not.toContain("w-[320px]");
  });

  it("点一行进详情页：索引让位，详情占满，且地址进到这一行", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    const row = (await screen.findByText("Alice")).closest(
      '[data-slot="org-index-row"]',
    ) as HTMLElement;
    fireEvent.click(within(row).getByTestId(/^org-row-select-/));

    expect(screen.getByTestId("org-detail-col")).toBeTruthy();
    expect(screen.queryByTestId("org-index-col")).toBeNull();
  });

  it("详情深链接直接进得去（手机返回键因此有用）", async () => {
    mockMobileViewport();
    renderOrgAt("/org/agent/agent-alice");

    const header = await screen.findByTestId("org-detail-header");
    // 手机页头只有名字作标题；可编辑的名字输入框在正文「身份」区（共享 IdentityFields）。
    expect(within(header).getByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(
      within(screen.getByTestId("org-detail-scroll")).getByRole("textbox", {
        name: "Name",
      }),
    ).toHaveProperty("value", "Alice");
  });

  it("详情头部带返回，按下去回索引", async () => {
    mockMobileViewport();
    renderOrgAt("/org/agent/agent-alice");

    const header = await screen.findByTestId("org-detail-header");
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));

    expect(await screen.findByText("Alice")).toBeTruthy();
    expect(screen.getByTestId("org-index-col")).toBeTruthy();
    expect(screen.queryByTestId("org-detail-col")).toBeNull();
  });

  it("桌面端仍然并排，且详情头部没有返回键（返回无处可去）", async () => {
    renderOrgAt("/org/agent/agent-alice");

    await screen.findByTestId("org-detail-header");
    // 并排由外壳摆：索引在外框的 index 槽，详情在内容页里。
    expect(
      within(screen.getByTestId("app-index")).getByTestId("org-index-col"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("app-sheet")).getByTestId("org-detail-col"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("org-detail-header")).queryByRole("button", {
        name: "Back",
      }),
    ).toBeNull();
  });
});

/**
 * 详情列可滚、失败提示跟着当前这一屏、工具栏「+」在移动端变两项菜单（决策 5、6）。
 */
describe("组织面移动形态：详情列可滚、失败跟随当前屏、工具栏「+」两项菜单", () => {
  it("看详情时详情列带 min-h-0，详情自己的滚动容器才生效", async () => {
    mockMobileViewport();
    renderOrgAt("/org/agent/agent-alice");

    await screen.findByTestId("org-detail-header");
    expect(screen.getByTestId("org-detail-col").className).toContain("min-h-0");
  });

  it("执行目标区的 sr-only 播报不撑高文档：详情滚动容器是它的定位祖先", async () => {
    // jsdom 量不了布局（滚到底继续滑文档会不会被推走），只能锚住成因：
    // sr-only 播报是 position:absolute，没有定位祖先时会以初始包含块（html 根）
    // 定位，把 static position 算到滚动内容深处，从而撑高 document。给详情
    // 自己的滚动容器加 relative，播报的包含块就落回这个容器内部。
    mockMobileViewport();
    renderOrgAt("/org/agent/agent-alice");

    await screen.findByTestId("org-detail-header");
    const scroll = screen.getByTestId("org-detail-scroll");
    expect(scroll.className).toContain("relative");

    const announcer = screen.getByTestId("exec-target-announcer");
    expect(scroll.contains(announcer)).toBe(true);
  });

  it("删除失败：同索引页文案的提示出现在详情头下方且不重复；返回索引后只在索引底部出现一条", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/org" && (!init || init.method === undefined))
        return chart;
      if (path === "/v1/workspace/org/backends") return { backends: [] };
      if (path === "/v1/workspace/org/agents/delete") {
        throw new Error("boom");
      }
      if (init?.method === "POST")
        return { sync_id: "new-sync-id", version: 1 };
      throw new Error(`unexpected request: ${path}`);
    });
    renderOrgAt("/org/agent/agent-alice");

    const header = await screen.findByTestId("org-detail-header");
    fireEvent.pointerDown(
      within(header).getByRole("button", { name: "More actions" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Something went wrong. Please try again.");
    // 落在详情头下方：同一列里，出现在 org-detail-header 之后。
    const detailCol = screen.getByTestId("org-detail-col");
    expect(within(detailCol).getByRole("alert")).toBe(alert);
    expect(
      Boolean(
        header.compareDocumentPosition(alert) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    // 只有这一条，索引列此刻没挂载，不会重复。
    expect(screen.getAllByRole("alert").length).toBe(1);

    fireEvent.click(within(header).getByRole("button", { name: "Back" }));

    const indexAlert = await screen.findByRole("alert");
    expect(indexAlert.textContent).toBe(
      "Something went wrong. Please try again.",
    );
    expect(screen.getAllByRole("alert").length).toBe(1);
    expect(within(screen.getByTestId("org-index-col")).getByRole("alert")).toBe(
      indexAlert,
    );
  });

  it("移动端工具栏「+」弹两项菜单：新建 Agent 与现在行为相同", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const toolbar = screen.getByTestId("org-index-toolbar");
    expect(
      within(toolbar).queryByRole("button", { name: "New agent" }),
    ).toBeNull();
    // 顶层页的页头是「☰ · 标题 · 页面动作（＋，≥44px）」：＋ 在页头，不在工具条。
    expect(
      within(toolbar).queryByRole("button", {
        name: "Add agent or department",
      }),
    ).toBeNull();
    const add = within(screen.getByTestId("app-topbar")).getByRole("button", {
      name: "Add agent or department",
    });
    expect(add.className).toContain("size-11");
    fireEvent.pointerDown(add, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "New agent" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New agent")).toBeTruthy();
  });

  it("移动端工具栏「+」的「新建顶层部门」打开与桌面新建部门相同的弹层，且上级为空", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    fireEvent.pointerDown(
      within(screen.getByTestId("app-topbar")).getByRole("button", {
        name: "Add agent or department",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "New top-level department",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New department")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Platform" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "Platform" }),
        }),
      ),
    );
  });

  it("桌面端「+」不变：点一下直接新建 Agent，没有菜单", async () => {
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const toolbar = screen.getByTestId("org-index-toolbar");
    expect(
      within(toolbar).queryByRole("button", {
        name: "Add agent or department",
      }),
    ).toBeNull();

    fireEvent.click(within(toolbar).getByRole("button", { name: "New agent" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New agent")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

/**
 * 手机形态（规格「Agent 与组织」）：两行索引行、组头摘要、chips 筛选、
 * 详情页头「‹ · 名字 · ⋯」与 身份 → 系统提示词 → 在哪儿跑 → 工具。
 */
describe("组织面手机形态：索引两行、摘要、chips", () => {
  const richChart: OrgChartResponse = {
    departments: [{ sync_id: "dept-eng", name: "Engineering", sort_order: 0 }],
    agents: [
      {
        sync_id: "agent-alice",
        name: "Alice",
        department_sync_id: "dept-eng",
        sort_order: 0,
        exec_targets: [
          {
            sync_id: "t1",
            rank: 1,
            backend_sync_id: "b1",
            backend_name: "Claude Code",
            device_id: 7,
            device_name: "mac-mini",
            device_unspecified: false,
            availability: "available",
            current: true,
          },
        ],
      },
      {
        sync_id: "agent-bob",
        name: "Bob",
        department_sync_id: "dept-eng",
        sort_order: 1,
        exec_targets: [
          {
            sync_id: "t2",
            rank: 1,
            backend_sync_id: "b2",
            backend_name: "Codex",
            device_id: 8,
            device_name: "linux-box",
            device_unspecified: false,
            availability: "offline",
            current: false,
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/org" && (!init || init.method === undefined))
        return richChart;
      if (path === "/v1/workspace/org/backends")
        return {
          backends: [
            { sync_id: "b1", name: "Claude Code" },
            { sync_id: "b2", name: "Codex" },
          ],
        };
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 7,
              name: "mac-mini",
              display_name: "Studio",
              kind: "agentred",
            },
          ],
        };
      if (init?.method === "POST") return { sync_id: "new", version: 1 };
      throw new Error(`unexpected request: ${path}`);
    });
  });

  it("行是两行档：第二行写备注名 · 后端，待配置的第二行写原因", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    await waitFor(() =>
      expect(screen.getAllByTestId(/^org-row-second-/)[0].textContent).toBe(
        "Studio · Claude Code",
      ),
    );
    const rows = screen.getAllByTestId(/^org-row-second-/);
    expect(rows).toHaveLength(2);
    // Bob 不能对话：原因可见地写在第二行，沿用 orgNeedsSetupReasons。
    expect(rows[1].textContent).toContain("linux-box");
  });

  it("组头是摘要档：「N 人 ›」，点它选中这个部门", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const header = screen.getByTestId(/^org-group-select-/);
    expect(header.textContent).toContain("2 people ›");
    expect(screen.queryByLabelText("New agent")).toBeNull();
    fireEvent.click(header);
    expect(await screen.findByTestId("org-detail-col")).toBeTruthy();
  });

  it("筛选是 chips（视觉 32px、点按区 44px）：点「Needs setup」只剩待配置的人，再点恢复", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const chips = screen.getByTestId("org-index-filter-chips");
    const needs = within(chips).getByRole("button", { name: "Needs setup" });
    // 视觉 32px（h-8），透明 ::before 上下各撑 6px 回到 44px 的点按区；与对话首页的共享
    // SessionFilterChips 同一口径（2026-11-19 选定的 B 稿）。
    expect(needs.className).toContain("h-8");
    expect(needs.className).toContain("before:-inset-y-1.5");
    expect(needs.className).not.toContain("min-h-11");
    // 横向滚动容器会把纵向溢出一起裁掉：容器得留出上下 6px，撑出来的点按区才不被裁；
    // 负外边距抵掉这 6px，排版与稿子一致。
    expect(chips.className).toContain("py-1.5");
    expect(chips.className).toContain("-my-1.5");
    expect(needs.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(needs);

    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(needs.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(needs);
    expect(await screen.findByText("Alice")).toBeTruthy();
  });

  // 第 11 项（2026-11-20 定稿 B）：搜索框与「筛选」手机上 36px，筛选的点按区由透明
  // ::before 上下各撑 4px 到 44px；桌面仍是 32px 一排。
  it("搜索框与「筛选」手机上 36px，筛选点按区撑到 44px", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const toolbar = screen.getByTestId("org-index-toolbar");
    const search = toolbar.querySelector('[data-slot="search-input"]')!;
    expect(search.className).toContain("h-9");
    const entry = screen.getByTestId("org-filter-entry");
    expect(entry.className).toContain("h-9");
    expect(entry.className).not.toContain("h-8");
    expect(entry.className).toContain("before:-inset-y-1");
  });

  it("后端 chip 单选过滤", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const chips = screen.getByTestId("org-index-filter-chips");
    fireEvent.click(within(chips).getByRole("button", { name: "Codex" }));
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("桌面不变：单行行、没有 chips、组头带动作", async () => {
    renderOrgAt("/org");
    await screen.findByText("Alice");

    expect(screen.queryAllByTestId(/^org-row-second-/)).toHaveLength(0);
    expect(screen.queryByTestId("org-index-filter-chips")).toBeNull();
    expect(screen.getByTestId("org-filter-entry").className).toContain("h-8");
    expect(
      screen
        .getByTestId("org-index-toolbar")
        .querySelector('[data-slot="search-input"]')!.className,
    ).toContain("h-8");
    expect(screen.getByTestId(/^org-group-add-agent-/)).toBeTruthy();
  });
});

describe("Agent 详情手机页头与分区顺序", () => {
  it("页头是「‹ · 名字 · ⋯」：没有 ✕，保存状态在副行", async () => {
    mockMobileViewport();
    renderOrgAt("/org/agent/agent-alice");
    const header = await screen.findByTestId("org-detail-header");

    expect(within(header).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "More actions" }),
    ).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();
    // 这一页的页头就是它：壳的「☰/‹ · 组织」顶栏不再叠在上面，整页只有一颗返回。
    expect(screen.queryByTestId("app-topbar")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Back" })).toHaveLength(1);
    // 页头动作的命中区 ≥44px。
    expect(
      within(header).getByRole("button", { name: "More actions" }).className,
    ).toContain("size-11");

    const name = within(screen.getByTestId("org-detail-scroll")).getByRole(
      "textbox",
      { name: "Name" },
    );
    fireEvent.change(name, { target: { value: "Alicia" } });
    fireEvent.blur(name);
    const status = await within(header).findByTestId("org-detail-save-status");
    const subtitle = within(header).getByTestId("org-detail-subtitle");
    expect(subtitle.contains(status)).toBe(true);
  });

  it("手机上顺序是 身份 → 系统提示词 → 在哪儿跑 → 工具", async () => {
    mockMobileViewport();
    renderOrgAt("/org/agent/agent-alice");
    await screen.findByTestId("org-detail-header");

    const scroll = screen.getByTestId("org-detail-scroll");
    const order = [
      scroll.querySelector('[data-slot="org-detail-col-identity"]'),
      screen.getByLabelText("System prompt", { selector: "textarea" }),
      scroll.querySelector('[data-slot="org-detail-col-execution"]'),
      scroll.querySelector('[data-slot="agent-section-tools"]'),
    ];
    order.forEach((el) => expect(el).toBeTruthy());
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        Boolean(
          order[i]!.compareDocumentPosition(order[i + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
    }
  });

  it("页头是统一的手机页头：‹ 与 •••、52px 外框色通栏；保存态 idle 时副行塌掉，标题居中", async () => {
    mockMobileViewport();
    renderOrgAt("/org/agent/agent-alice");
    const header = await screen.findByTestId("org-detail-header");
    expect(header.getAttribute("data-slot")).toBe("phone-page-header");
    expect(header.className).toContain("bg-chrome");
    expect(
      within(header)
        .getByRole("button", { name: "Back" })
        .querySelector("svg.lucide-chevron-left"),
    ).not.toBeNull();
    expect(
      within(header)
        .getByRole("button", { name: "More actions" })
        .querySelector("svg.lucide-ellipsis"),
    ).not.toBeNull();
    const subtitle = within(header).getByTestId("org-detail-subtitle");
    expect(subtitle.className).toContain("empty:hidden");
    expect(subtitle.childNodes).toHaveLength(0);
  });

  it("桌面详情头仍带 ✕", async () => {
    renderOrgAt("/org/agent/agent-alice");
    const header = await screen.findByTestId("org-detail-header");
    expect(within(header).getByRole("button", { name: "Close" })).toBeTruthy();
  });
});

/**
 * 部门详情手机页头（2026-11-20 第 1 项）：与 Agent 详情同形——自带「‹ · 部门名 · •••」，
 * 壳的「‹ · 组织」不再叠在上面；身份编辑挪进正文「身份」段，没有 ✕。
 */
describe("部门详情手机页头", () => {
  it("只有一条页头：‹ · Engineering · •••，没有 ✕；身份在正文", async () => {
    mockMobileViewport();
    renderOrgAt("/org/department/dept-eng");
    const header = await screen.findByTestId("org-detail-header");

    expect(screen.queryByTestId("app-topbar")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Back" })).toHaveLength(1);
    expect(
      within(header).getByRole("heading", { name: "Engineering" }),
    ).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "More actions" }),
    ).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Close" })).toBeNull();
    // 页头里没有可编辑的名字：编辑挪进正文「身份」段。
    expect(within(header).queryByRole("textbox")).toBeNull();
    const identity = screen.getByRole("region", { name: "Identity" });
    expect(
      within(identity).getByRole("textbox", { name: "Name" }),
    ).toBeTruthy();
  });

  it("桌面部门详情头不变：仍带 ✕，名字在头部里编辑", async () => {
    renderOrgAt("/org/department/dept-eng");
    const header = await screen.findByTestId("org-detail-header");
    expect(within(header).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(within(header).getByRole("textbox", { name: "Name" })).toBeTruthy();
  });
});

function HistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="path">{location.pathname}</span>
      <button onClick={() => navigate(-1)}>system-back</button>
    </>
  );
}

function renderOrgHistory(entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <ThemeProvider>
        <HistoryProbe />
        <Routes>
          <Route path="/org/:kind?/:syncId?" element={<Org />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const systemBack = () => fireEvent.click(screen.getByText("system-back"));

/** react-router 在 window.history.state 记着自己的位置；MemoryRouter 不写它，用例手动垫。 */
function setHistoryIdx(idx: number | undefined) {
  window.history.replaceState(idx === undefined ? null : { idx }, "");
}

/**
 * 页头 ‹ = 回到上一处（规格 2026-11-25 D3）：有上一处就退一步，否则以替换方式回到
 * 上级；两种情况历史都不能变长。
 */
describe("Agent / 部门详情 ‹ 不 push（D3、I11）", () => {
  afterEach(() => setHistoryIdx(undefined));

  it("有上一处：‹ 退一步，随后系统返回直接到更早的一页，不会回到刚离开的 Agent", async () => {
    mockMobileViewport();
    setHistoryIdx(2);
    renderOrgHistory(["/start", "/org", "/org/agent/agent-alice"]);

    const header = await screen.findByTestId("org-detail-header");
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/org"),
    );
    systemBack();
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/start"),
    );
  });

  it("深链进 Agent 没有上一处：‹ 以替换回 /org，系统返回回到进来之前", async () => {
    mockMobileViewport();
    setHistoryIdx(undefined);
    renderOrgHistory(["/start", "/org/agent/agent-alice"]);

    const header = await screen.findByTestId("org-detail-header");
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/org"),
    );
    systemBack();
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/start"),
    );
  });

  it("部门详情同一条规则", async () => {
    mockMobileViewport();
    setHistoryIdx(undefined);
    renderOrgHistory(["/start", "/org/department/dept-eng"]);

    const header = await screen.findByTestId("org-detail-header");
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/org"),
    );
    systemBack();
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/start"),
    );
  });
});

/**
 * Agent 系统提示词与描述离开页面时自动保存（F4、I12）：返回、卸载、页面进后台
 * （pagehide）都先存一次；没改过不存，已经存过不重复存。
 */
describe("Agent 系统提示词与描述离开即存（F4、I12）", () => {
  const updates = () =>
    mockedApi.mock.calls
      .filter((c) => c[0] === "/v1/workspace/org/agents/update")
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
  const promptBox = () =>
    screen.getByLabelText("System prompt", { selector: "textarea" });

  afterEach(() => setHistoryIdx(undefined));

  it("打完字直接点 ‹（不失焦）：提示词与描述都存了", async () => {
    mockMobileViewport();
    renderOrgHistory(["/org/agent/agent-alice"]);
    const header = await screen.findByTestId("org-detail-header");
    fireEvent.change(promptBox(), { target: { value: "Be brief" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Ops helper" },
    });
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));

    await waitFor(() => expect(updates().length).toBe(2));
    expect(updates()).toContainEqual({
      sync_id: "agent-alice",
      prompt_json: JSON.stringify(["Be brief"]),
    });
    expect(updates()).toContainEqual({
      sync_id: "agent-alice",
      description: "Ops helper",
    });
  });

  it("页面进后台（pagehide）也存，随后离开不再重复存", async () => {
    mockMobileViewport();
    renderOrgHistory(["/org/agent/agent-alice"]);
    const header = await screen.findByTestId("org-detail-header");
    fireEvent.change(promptBox(), { target: { value: "Be brief" } });
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(updates().length).toBe(1));

    fireEvent.click(within(header).getByRole("button", { name: "Back" }));
    await screen.findByTestId("org-index-col");
    expect(updates().length).toBe(1);
  });

  it("失焦已存过，再离开不重复存", async () => {
    mockMobileViewport();
    renderOrgHistory(["/org/agent/agent-alice"]);
    const header = await screen.findByTestId("org-detail-header");
    fireEvent.change(promptBox(), { target: { value: "Be brief" } });
    fireEvent.blur(promptBox());
    await waitFor(() => expect(updates().length).toBe(1));

    fireEvent.click(within(header).getByRole("button", { name: "Back" }));
    await screen.findByTestId("org-index-col");
    expect(updates().length).toBe(1);
  });

  it("没改过的文字离开不存", async () => {
    mockMobileViewport();
    renderOrgHistory(["/org/agent/agent-alice"]);
    const header = await screen.findByTestId("org-detail-header");
    window.dispatchEvent(new Event("pagehide"));
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));
    await screen.findByTestId("org-index-col");
    expect(updates().length).toBe(0);
  });

  it("存失败：文字留在框里，页头出现既有的「保存失败 + 重试」", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/org" && (!init || init.method === undefined))
        return chart;
      if (path === "/v1/workspace/org/backends") return { backends: [] };
      if (path === "/v1/workspace/org/agents/update") throw new Error("boom");
      throw new Error(`unexpected request: ${path}`);
    });
    renderOrgHistory(["/org/agent/agent-alice"]);
    const header = await screen.findByTestId("org-detail-header");
    fireEvent.change(promptBox(), { target: { value: "Be brief" } });
    window.dispatchEvent(new Event("pagehide"));

    const status = await within(header).findByTestId("org-detail-save-status");
    await waitFor(() => expect(status.textContent).toContain("boom"));
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect((promptBox() as HTMLTextAreaElement).value).toBe("Be brief");
  });

  it("存成功：页头下显示「已保存」", async () => {
    mockMobileViewport();
    renderOrgHistory(["/org/agent/agent-alice"]);
    const header = await screen.findByTestId("org-detail-header");
    fireEvent.change(promptBox(), { target: { value: "Be brief" } });
    window.dispatchEvent(new Event("pagehide"));

    const status = await within(header).findByTestId("org-detail-save-status");
    await waitFor(() => expect(status.textContent).toMatch(/Saved/));
  });

  it("部门描述同样离开即存", async () => {
    mockMobileViewport();
    renderOrgHistory(["/org/department/dept-eng"]);
    const header = await screen.findByTestId("org-detail-header");
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Builders" },
    });
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "/v1/workspace/org/departments/update",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
