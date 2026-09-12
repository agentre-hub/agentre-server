import { fireEvent, render, screen, within } from "@testing-library/react";
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
