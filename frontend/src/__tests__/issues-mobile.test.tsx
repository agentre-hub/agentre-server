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
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import { api } from "@/lib/api";
import Issues from "@/pages/Issues";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// 「网络不稳定」细条的开关：核对失败时 useMe 报 unstable（外壳与看板页头都读它）。
let meStatus: "ready" | "unstable" = "ready";
vi.mock("@/hooks/use-me", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-me")>();
  return { ...actual, useMe: () => ({ ...actual.useMe(), status: meStatus }) };
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
const systemBack = () => fireEvent.click(screen.getByText("system-back"));

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
    <MemoryRouter initialEntries={["/prev", "/issues"]} initialIndex={1}>
      <HistoryProbe />
      <Issues />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
  await screen.findByTestId("issue-board");
}

beforeEach(async () => {
  meStatus = "ready";
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
    // 统一的手机页头（2026-11-20 第 14 项）：52px 外框色通栏，不是 44px 无底色。
    expect(header.getAttribute("data-slot")).toBe("phone-page-header");
    expect(header.className).toContain("bg-chrome");
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

describe("看板卡片与搜索框（J3、F20 宿主侧）", () => {
  it("卡片上没有 #N：那是本页的临时代号，不是稳定编号", async () => {
    await renderPhoneBoard();

    const board = screen.getByTestId("issue-board");
    expect(board.textContent).toContain("Fix the login redirect");
    expect(board.textContent).not.toMatch(/#\d/);
  });

  it("搜索框占位是「搜索任务…」，不提编号；44px 高，计数带标签", async () => {
    await renderPhoneBoard();

    const input = screen.getByPlaceholderText("Search tasks…");
    expect(input.getAttribute("aria-label")).toBe("Search tasks…");
    expect(screen.getByTestId("board-search").innerHTML).toContain("h-11");
    expect(screen.getByTestId("board-search-count").textContent).toMatch(
      /\d+ tasks?/,
    );
  });
});

describe("看板页头下的「网络不稳定」细条（任务 10 遗留）", () => {
  it("细条紧贴页头下方、只有一条，不压在筛选条或卡片上", async () => {
    meStatus = "unstable";
    await renderPhoneBoard();

    const strips = screen.getAllByTestId("identity-unstable");
    expect(strips).toHaveLength(1);
    expect(screen.getByTestId("issues-mobile-header").nextElementSibling).toBe(
      strips[0],
    );
  });

  it("网络正常时不画", async () => {
    await renderPhoneBoard();
    expect(screen.queryByTestId("identity-unstable")).toBeNull();
  });
});

describe("任务整屏页的历史与未保存改动（D2、F4）", () => {
  const openFirstTask = async () => {
    fireEvent.click(screen.getAllByTestId(/^board-card-body-/)[0]);
    return screen.findByTestId("task-form");
  };

  it("没改动：系统返回直接关掉任务页、停在看板，不弹确认", async () => {
    await renderPhoneBoard();
    await openFirstTask();

    systemBack();

    await waitFor(() => expect(screen.queryByTestId("task-form")).toBeNull());
    expect(screen.queryByTestId("confirm-sheet")).toBeNull();
    expect(screen.getByTestId("path").textContent).toBe("/issues");
  });

  it("没改动：✕ 直接关、不弹确认，再返回就是上一页（记号已退掉）", async () => {
    await renderPhoneBoard();
    await openFirstTask();

    fireEvent.click(screen.getByTestId("task-form-close"));

    await waitFor(() => expect(screen.queryByTestId("task-form")).toBeNull());
    expect(screen.queryByTestId("confirm-sheet")).toBeNull();
    systemBack();
    expect(screen.getByTestId("path").textContent).toBe("/prev");
  });

  it("改了标题点 ✕：先问「放弃未保存的修改？」，继续编辑为主，选了继续编辑留在任务页", async () => {
    await renderPhoneBoard();
    await openFirstTask();
    fireEvent.change(screen.getByTestId("task-title"), {
      target: { value: "Changed title" },
    });

    fireEvent.click(screen.getByTestId("task-form-close"));

    const sheet = await screen.findByTestId("confirm-sheet");
    expect(within(sheet).getByText("Discard unsaved changes?")).toBeTruthy();
    const keep = within(sheet).getByRole("button", { name: "Keep editing" });
    const discard = within(sheet).getByRole("button", { name: "Discard" });
    // 继续编辑是主按钮，排在放弃上面，44px 满宽堆叠。
    expect(keep.compareDocumentPosition(discard)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(keep.getAttribute("data-variant")).toBe("default");
    expect(keep.className).toContain("h-11");
    expect(keep.className).toContain("w-full");

    fireEvent.click(keep);
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-sheet")).toBeNull(),
    );
    expect((screen.getByTestId("task-title") as HTMLInputElement).value).toBe(
      "Changed title",
    );
  });

  it("改了标题点 ✕ 再选放弃：关掉任务页，历史回到打开前（再返回是上一页）", async () => {
    await renderPhoneBoard();
    await openFirstTask();
    fireEvent.change(screen.getByTestId("task-title"), {
      target: { value: "Changed title" },
    });
    fireEvent.click(screen.getByTestId("task-form-close"));
    const sheet = await screen.findByTestId("confirm-sheet");

    fireEvent.click(within(sheet).getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(screen.queryByTestId("task-form")).toBeNull());
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-sheet")).toBeNull(),
    );
    systemBack();
    expect(screen.getByTestId("path").textContent).toBe("/prev");
  });

  it("改了标题按系统返回：同样先问，任务页还在；继续编辑后再返回仍然先问", async () => {
    await renderPhoneBoard();
    await openFirstTask();
    fireEvent.change(screen.getByTestId("task-title"), {
      target: { value: "Changed title" },
    });

    systemBack();
    const sheet = await screen.findByTestId("confirm-sheet");
    expect(screen.getByTestId("task-form")).toBeTruthy();
    expect(screen.getByTestId("path").textContent).toBe("/issues");

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-sheet")).toBeNull(),
    );
    expect(screen.getByTestId("task-form")).toBeTruthy();
    expect(screen.getByTestId("path").textContent).toBe("/issues");

    // 记号补回来了：再按一次返回还是先问，而不是直接离开看板。
    systemBack();
    expect(await screen.findByTestId("confirm-sheet")).toBeTruthy();
    expect(screen.getByTestId("path").textContent).toBe("/issues");
  });

  it("改了标题按系统返回、再选放弃：关掉任务页并停在看板", async () => {
    await renderPhoneBoard();
    await openFirstTask();
    fireEvent.change(screen.getByTestId("task-title"), {
      target: { value: "Changed title" },
    });
    systemBack();
    const sheet = await screen.findByTestId("confirm-sheet");

    fireEvent.click(within(sheet).getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(screen.queryByTestId("task-form")).toBeNull());
    expect(screen.getByTestId("path").textContent).toBe("/issues");
    systemBack();
    expect(screen.getByTestId("path").textContent).toBe("/prev");
  });

  it("改回原样等于没改：不弹确认", async () => {
    await renderPhoneBoard();
    await openFirstTask();
    const title = screen.getByTestId("task-title") as HTMLInputElement;
    const original = title.value;
    fireEvent.change(title, { target: { value: "x" } });
    fireEvent.change(title, { target: { value: original } });

    fireEvent.click(screen.getByTestId("task-form-close"));

    await waitFor(() => expect(screen.queryByTestId("task-form")).toBeNull());
    expect(screen.queryByTestId("confirm-sheet")).toBeNull();
  });

  it("只改了属性（换阶段）也算改动：✕ 先问", async () => {
    await renderPhoneBoard();
    await openFirstTask();
    fireEvent.pointerDown(screen.getByTestId("task-pill-stage"));
    fireEvent.click(screen.getByTestId("task-pill-stage"));
    fireEvent.click(await screen.findByTestId("task-stage-review"));

    fireEvent.click(screen.getByTestId("task-form-close"));

    expect(await screen.findByTestId("confirm-sheet")).toBeTruthy();
  });

  it("保存键在页头右侧是文字键，不是实心按钮", async () => {
    await renderPhoneBoard();
    await openFirstTask();
    expect(screen.getByTestId("issues-task-page").className).toContain(
      "[&_[data-testid=task-form-submit]]:bg-transparent",
    );
  });
});

/**
 * 看板手机上的浮层（规格 2026-11-25 D1）：标签管理框系统返回先关它、停在看板。
 * 任务页上的机器与模型选择见 issues-pills.test.tsx。
 */
describe("看板手机浮层：系统返回先关浮层（D1）", () => {
  it("标签管理框：返回关掉它，停在看板", async () => {
    await renderPhoneBoard();
    fireEvent.click(screen.getByTestId("filter-trigger"));
    const sheet = await screen.findByTestId("filter-sheet");
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Manage labels" }),
    );
    await screen.findByRole("heading", { name: "Labels" });
    systemBack();
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Labels" })).toBeNull(),
    );
    expect(screen.getByTestId("path").textContent).toBe("/issues");
  });

  it("筛选弹层：返回只关它，停在看板；选项里改的不会留下多余历史", async () => {
    await renderPhoneBoard();
    fireEvent.click(screen.getByTestId("filter-trigger"));
    await screen.findByTestId("filter-sheet");
    systemBack();
    await waitFor(() =>
      expect(screen.queryByTestId("filter-sheet")).toBeNull(),
    );
    expect(screen.getByTestId("path").textContent).toBe("/issues");
    // 记号已被返回键退掉：再返回才离开看板。
    systemBack();
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/prev"),
    );
  });

  it("项目范围弹层：返回只关它，停在看板", async () => {
    await renderPhoneBoard();
    fireEvent.click(screen.getByTestId("scope-trigger"));
    await screen.findByTestId("scope-sheet");
    systemBack();
    await waitFor(() => expect(screen.queryByTestId("scope-sheet")).toBeNull());
    expect(screen.getByTestId("path").textContent).toBe("/issues");
  });

  it("卡片 ⋯ 菜单：返回只关菜单，停在看板", async () => {
    await renderPhoneBoard();
    fireEvent.click(screen.getAllByTestId(/^board-card-menu-/)[0]);
    await screen.findByTestId(/^board-card-sheet-/);
    systemBack();
    await waitFor(() =>
      expect(screen.queryByTestId(/^board-card-sheet-/)).toBeNull(),
    );
    expect(screen.getByTestId("path").textContent).toBe("/issues");
  });

  it("任务页的 ⋯ 菜单：返回只关菜单，任务页与看板都还在", async () => {
    await renderPhoneBoard();
    fireEvent.click(screen.getAllByTestId(/^board-card-body-/)[0]);
    await screen.findByTestId("task-form");
    fireEvent.pointerDown(screen.getByTestId("task-form-more"), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByTestId("task-form-delete");
    systemBack();
    await waitFor(() =>
      expect(screen.queryByTestId("task-form-delete")).toBeNull(),
    );
    expect(screen.getByTestId("task-form")).toBeTruthy();
    expect(screen.getByTestId("path").textContent).toBe("/issues");
  });
});
