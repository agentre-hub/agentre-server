/**
 * 看板的手机形态（规格 2026-11-05 手机 PWA「看板」）：阶段标签、满宽卡片、项目范围进
 * 标题、新建进页头 ＋、筛选与范围走底部弹层、移动靠 ⋯ / 长按、任务详情整屏。
 * 桌面形态由 issues-page / issues-edges 守，这里只钉手机这一棵树。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import { api } from "@/lib/api";
import Issues from "@/pages/Issues";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);
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

const issue = (id: string, title: string, stage: string) => ({
  sync_id: id,
  title,
  description: "",
  stage,
  position: 1,
  project_sync_id: "proj-web",
  closed_at: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_100_000,
  labels: [],
});

const board = {
  issues: [
    issue("iss-1", "Fix the login redirect", "todo"),
    issue("iss-2", "Ship the board", "doing"),
  ],
  labels: [],
  stage_counts: { todo: 1, doing: 1, review: 0, done: 0 },
  stage_totals: { todo: 1, doing: 1, review: 0, done: 0 },
  project_counts: [{ project_sync_id: "proj-web", count: 2 }],
};

function lastWrite(path: string): Record<string, unknown> {
  const call = mockedApi.mock.calls.filter(([p]) => p === path).at(-1);
  if (!call) throw new Error(`没有请求打到 ${path}`);
  return JSON.parse(String((call[1] as RequestInit).body));
}

async function renderPhoneBoard() {
  mockMobileViewport();
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return { sync_id: "new-sync-id", version: 1 };
    if (path.startsWith("/v1/workspace/issues")) return board;
    if (path === "/v1/workspace/projects")
      return {
        projects: [
          { sync_id: "proj-web", name: "Web", color: "agent-1", sort_order: 0 },
        ],
      };
    if (path === "/v1/workspace/agents") return { agents: [] };
    if (path === "/v1/workspace/org/backends") return { backends: [] };
    if (path === "/v1/engine/providers") return { providers: [] };
    if (path === "/v1/engine/backends") return { backends: [] };
    if (path === "/v1/devices") return { devices: [] };
    if (path === "/v1/auth/me")
      return {
        user_id: 1,
        email: "dev@agentre.dev",
        display_name: "Dev",
        avatar_url: "",
        github_login: "dev",
        csrf_token: "t",
      };
    throw new Error(`unexpected request: ${path}`);
  });
  render(
    <MemoryRouter initialEntries={["/issues"]}>
      <Issues />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
  await screen.findByTestId("issue-board");
}

beforeEach(async () => {
  mockedApi.mockReset();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("看板手机形态", () => {
  it("一次只看一个阶段：顶部四个带条数的标签，切换换列，卡片没有拖拽", async () => {
    await renderPhoneBoard();

    expect(screen.getByTestId("board-stage-tabs")).toBeTruthy();
    expect(screen.queryByTestId("board-column-doing")).toBeNull();
    expect(screen.getByText("Fix the login redirect")).toBeTruthy();

    fireEvent.click(screen.getByTestId("board-stage-tab-doing"));
    expect(await screen.findByText("Ship the board")).toBeTruthy();
    expect(screen.queryByText("Fix the login redirect")).toBeNull();
  });

  it("页头自己画：☰ · 项目范围作标题 · ＋ 新建；壳的顶栏让位", async () => {
    await renderPhoneBoard();

    expect(screen.queryByTestId("app-topbar")).toBeNull();
    const header = screen.getByTestId("issues-mobile-header");
    expect(
      within(header).getByRole("button", { name: "Open menu" }),
    ).toBeTruthy();
    // 范围选择器是弹层档，在页头里。
    expect(within(header).getByTestId("scope-trigger")).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "New task" }),
    ).toBeTruthy();
  });

  it("筛选收进底部弹层，按钮写出会看到几条", async () => {
    await renderPhoneBoard();

    fireEvent.click(screen.getByTestId("filter-trigger"));
    const sheet = await screen.findByTestId("filter-sheet");
    expect(within(sheet).getByTestId("filter-sheet-apply").textContent).toMatch(
      /Show \d+ tasks/,
    );
  });

  it("点卡片上的 ⋯ 弹出「移动到」，选阶段即按同步标识移动", async () => {
    await renderPhoneBoard();

    fireEvent.click(screen.getAllByTestId(/^board-card-menu-/)[0]);
    const sheet = await screen.findByTestId(/^board-card-sheet-/);
    fireEvent.click(within(sheet).getByRole("button", { name: /Review/ }));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues/move")).toMatchObject({
        sync_id: "iss-1",
        stage: "review",
      });
    });
  });

  it("任务是整屏页而不是居中弹窗：dvh 高容器，无取消按钮，保存在页头", async () => {
    await renderPhoneBoard();

    fireEvent.click(screen.getAllByTestId(/^board-card-body-/)[0]);
    const form = await screen.findByTestId("task-form");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("issues-task-page").className).toContain("h-dvh");
    expect(screen.getByTestId("task-form-close")).toBeTruthy();
    expect(within(form).queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(screen.getByTestId("task-form-close"));
    await waitFor(() => expect(screen.queryByTestId("task-form")).toBeNull());
  });

  it("页头 ＋ 新建任务并经整屏页保存", async () => {
    await renderPhoneBoard();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByTestId("task-title"), {
      target: { value: "Phone task" },
    });
    fireEvent.click(screen.getByTestId("task-form-submit"));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues")).toMatchObject({
        title: "Phone task",
      });
    });
  });
});
