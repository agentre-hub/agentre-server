import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
    expect(within(header).getByText("Alice")).toBeTruthy();
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
    expect(screen.getByTestId("org-index-col")).toBeTruthy();
    expect(screen.getByTestId("org-layout").className).toContain("flex-row");
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
    fireEvent.pointerDown(
      within(toolbar).getByRole("button", {
        name: "Add agent or department",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "New agent" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New agent")).toBeTruthy();
  });

  it("移动端工具栏「+」的「新建顶层部门」打开与桌面新建部门相同的弹层，且上级为空", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");

    const toolbar = screen.getByTestId("org-index-toolbar");
    fireEvent.pointerDown(
      within(toolbar).getByRole("button", {
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
