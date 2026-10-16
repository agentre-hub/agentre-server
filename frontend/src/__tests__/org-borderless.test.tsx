import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import * as accountChannel from "@/lib/accountChannel";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Org from "@/pages/Org";
import type { OrgChartResponse } from "@/pages/org/types";
import { edgeClasses } from "./helpers/edge-classes";

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
      exec_targets: [
        {
          sync_id: "et-1",
          rank: 1,
          backend_sync_id: "backend-1",
          backend_name: "Claude Code",
          backend_type: "claude_code",
          device_unspecified: false,
          availability: "available",
          current: true,
        },
        {
          sync_id: "et-2",
          rank: 2,
          backend_sync_id: "backend-2",
          backend_name: "Codex",
          backend_type: "codex",
          device_unspecified: false,
          availability: "available",
          current: false,
        },
      ],
    },
  ],
};

const originalMatchMedia = window.matchMedia;

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
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/workspace/org") return chart;
    if (path === "/v1/workspace/org/backends") return { backends: [] };
    throw new Error(`unexpected request: ${path}`);
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("组织页无边框：索引列在外框，详情是内容页", () => {
  it("桌面：索引列经 AppShell index 落在外框上，详情在内容页里，索引自己不画底色", async () => {
    renderOrgAt("/org/agent/agent-alice");
    await screen.findByTestId("org-detail-header");

    const indexCol = screen.getByTestId("org-index-col");
    expect(
      within(screen.getByTestId("app-index")).getByTestId("org-index-col"),
    ).toBe(indexCol);
    expect(screen.getByTestId("app-sheet").contains(indexCol)).toBe(false);
    expect(
      within(screen.getByTestId("app-sheet")).getByTestId("org-detail-col"),
    ).toBeTruthy();
    expect(indexCol.className).toContain("w-[320px]");
    expect(indexCol.className).not.toMatch(/(^|\s)bg-/);
  });

  it("桌面：索引列、详情头、执行目标分组、选择器都没有边线", async () => {
    renderOrgAt("/org/agent/agent-alice");
    await screen.findByTestId("org-detail-header");

    expect(edgeClasses(screen.getByTestId("org-index-col"))).toEqual([]);
    expect(edgeClasses(screen.getByTestId("app-sheet"))).toEqual([]);
  });

  it("桌面：搜索框可收缩、筛选按钮不收缩，不会被 320px 列边裁掉", async () => {
    renderOrgAt("/org");
    await screen.findByText("Alice");
    const filter = screen.getByTestId("org-filter-entry");
    expect(filter.className).toContain("shrink-0");
    const search = screen.getByRole("searchbox", { name: /search/i });
    expect(search.closest(".min-w-0")).not.toBeNull();
  });

  it("移动：仍是单栏切换，索引不在外框槽里", async () => {
    mockMobileViewport();
    renderOrgAt("/org");
    await screen.findByText("Alice");
    expect(screen.queryByTestId("app-index")).toBeNull();
    expect(screen.getByTestId("org-index-col")).toBeTruthy();
    expect(screen.queryByTestId("org-detail-col")).toBeNull();
    expect(edgeClasses(screen.getByTestId("org-index-col"))).toEqual([]);
  });
});
