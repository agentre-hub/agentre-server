/**
 * 控制台 /issues（规格 2026-08-27「`agentre-server` 端」）。
 *
 * 这一页**没有自己的呈现件**：板、筛选、范围选择器、任务表单与标签管理全是
 * `@agentre-hub/agentre-ui` 的看板一族，两端渲染同一份。所以这里钉的是宿主那一半
 * ——取数走那八条端点、六个筛选翻成 query string、写回去落在哪条路径上，以及 web
 * 与桌面端**唯一**的那处功能差别：机器那颗 pill 只能从账号里已有的后端里挑一个。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import App from "@/App";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import Issues from "@/pages/Issues";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const board = {
  issues: [
    {
      sync_id: "iss-1",
      title: "Fix the login redirect",
      description: "it loops",
      stage: "todo",
      position: 1,
      project_sync_id: "proj-web",
      agent_sync_id: "agent-alice",
      // 这一档在账号的后端清单里已经没有了（在别处删掉的）。
      agent_backend_sync_id: "backend-9",
      closed_at: 0,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_100_000,
      labels: [
        { sync_id: "lab-bug", name: "bug", tone: "red", usage_count: 0 },
      ],
    },
    {
      sync_id: "iss-2",
      title: "Ship the board",
      description: "",
      stage: "doing",
      position: 1,
      project_sync_id: "",
      closed_at: 0,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_200_000,
      labels: [],
    },
  ],
  labels: [{ sync_id: "lab-bug", name: "bug", tone: "red", usage_count: 4 }],
  stage_counts: { todo: 1, doing: 1, review: 0, done: 0 },
  stage_totals: { todo: 1, doing: 1, review: 0, done: 2 },
  project_counts: [
    { project_sync_id: "proj-web", count: 5 },
    { project_sync_id: "", count: 1 },
  ],
};

const projects = [
  { sync_id: "proj-web", name: "Web", color: "agent-1", sort_order: 0 },
  {
    sync_id: "proj-api",
    name: "API",
    color: "agent-2",
    parent_sync_id: "proj-web",
    sort_order: 0,
  },
];

const agents = [
  {
    sync_id: "agent-alice",
    name: "Alice",
    avatar_color: "agent-3",
    has_available_target: true,
    exec_targets: [],
  },
];

const backends = [
  {
    sync_id: "backend-1",
    name: "Claude Code",
    backend_type: "claude_code",
    device_name: "MacBook",
    is_local_reference: false,
    availability: "available",
  },
  {
    sync_id: "backend-2",
    name: "Codex",
    backend_type: "codex",
    device_name: "builder",
    is_local_reference: false,
    availability: "offline",
  },
];

/** 最近一次看板取数的 query string。 */
function lastBoardQuery(): URLSearchParams {
  const calls = mockedApi.mock.calls.filter(([path]) =>
    String(path).startsWith("/v1/workspace/issues?"),
  );
  const last = calls.at(-1);
  if (!last) throw new Error("看板还没有取过数");
  return new URLSearchParams(String(last[0]).split("?")[1]);
}

/** 写那七条：路径 + 请求体。 */
function lastWrite(path: string): Record<string, unknown> {
  const call = mockedApi.mock.calls.filter(([p]) => p === path).at(-1);
  if (!call) throw new Error(`没有请求打到 ${path}`);
  return JSON.parse(String((call[1] as RequestInit).body));
}

function mockBoardApi() {
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return { sync_id: "new-sync-id", version: 1 };
    if (path.startsWith("/v1/workspace/issues")) return board;
    if (path === "/v1/workspace/projects") return { projects };
    if (path === "/v1/workspace/agents") return { agents };
    if (path === "/v1/workspace/org/backends") return { backends };
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
}

async function renderBoard() {
  const view = render(
    <MemoryRouter initialEntries={["/issues"]}>
      <Issues />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
  await screen.findByTestId("issue-board");
  return view;
}

/** Radix 的 dropdown 开在 pointerdown 上，popover 开在 click 上：两下都发。 */
function open(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

beforeEach(async () => {
  mockedApi.mockReset();
  await i18n.changeLanguage("en");
});

describe("/issues renders the shared board family", () => {
  it("draws the account's tasks with the shared IssueBoard, not a server-local copy", async () => {
    mockBoardApi();
    await renderBoard();

    const todo = screen.getByTestId("board-column-todo");
    expect(within(todo).getByText("Fix the login redirect")).toBeTruthy();
    expect(
      within(screen.getByTestId("board-column-doing")).getByText(
        "Ship the board",
      ),
    ).toBeTruthy();
  });

  it("is reachable from the sidebar as its own destination", async () => {
    mockBoardApi();
    await renderBoard();

    expect(
      screen.getByRole("link", { name: "Board" }).getAttribute("href"),
    ).toBe("/issues");
  });

  it("serves /issues from the router rather than the catch-all 404", async () => {
    mockBoardApi();
    window.history.pushState({}, "", "/issues");
    render(<App />, { wrapper: ThemeProvider });

    expect(await screen.findByTestId("issue-board")).toBeTruthy();
  });
});

describe("the six filters travel to the server", () => {
  it("narrows to a project subtree by sync id", async () => {
    mockBoardApi();
    await renderBoard();

    open(screen.getByTestId("scope-trigger"));
    fireEvent.click(await screen.findByText("API"));

    await waitFor(() => {
      expect(lastBoardQuery().get("project_sync_id")).toBe("proj-api");
    });
    expect(lastBoardQuery().get("scope")).toBe("project");
  });

  it("asks for no ordering at all — the board's order is the one people dragged", async () => {
    mockBoardApi();
    await renderBoard();

    // 决策 10「不给看板加排序」：线上再没有一条能盖掉 position 的次序。
    expect(lastBoardQuery().has("sort")).toBe(false);
  });

  it("sends 「全部满足」 rather than 「任意一个」 once the user asks for it", async () => {
    mockBoardApi();
    await renderBoard();

    open(screen.getByTestId("filter-trigger"));
    fireEvent.click(await screen.findByTestId("filter-match-all"));

    await waitFor(() => {
      expect(lastBoardQuery().get("label_match_all")).toBe("true");
    });
  });
});

describe("card actions land on the write endpoints", () => {
  it("moves a card by sync id, not by a made-up number", async () => {
    mockBoardApi();
    await renderBoard();

    const todo = screen.getByTestId("board-column-todo");
    open(within(todo).getByTestId(/^board-card-menu-/));
    open(await screen.findByText("Move to"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Review" }));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues/move")).toMatchObject({
        sync_id: "iss-1",
        stage: "review",
      });
    });
  });

  it("deletes a card by sync id", async () => {
    mockBoardApi();
    await renderBoard();

    const todo = screen.getByTestId("board-column-todo");
    open(within(todo).getByTestId(/^board-card-menu-/));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues/delete")).toEqual({
        sync_id: "iss-1",
      });
    });
  });
});

describe("the task form writes what the browser is allowed to write", () => {
  it("creates a task with the stage and project it inherited", async () => {
    mockBoardApi();
    await renderBoard();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByTestId("task-title"), {
      target: { value: "Write it down" },
    });
    fireEvent.click(screen.getByTestId("task-form-submit"));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues")).toMatchObject({
        title: "Write it down",
        stage: "todo",
      });
    });
  });

  it("starts in the column whose + opened it", async () => {
    mockBoardApi();
    await renderBoard();

    fireEvent.click(screen.getByTestId("board-column-add-review"));
    fireEvent.change(await screen.findByTestId("task-title"), {
      target: { value: "Review this" },
    });
    fireEvent.click(screen.getByTestId("task-form-submit"));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues")).toMatchObject({
        title: "Review this",
        stage: "review",
      });
    });
  });

  it("keeps none of the machine and model once the agent is cleared", async () => {
    mockBoardApi();
    await renderBoard();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByTestId("task-title"), {
      target: { value: "No one yet" },
    });
    open(await screen.findByTestId("task-pill-agent"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Alice/ }));
    open(await screen.findByTestId("board-exec-target-pill"));
    fireEvent.click(
      await screen.findByTestId("board-exec-target-row-backend-1"),
    );

    // 再把 Agent 摘掉：那两颗 pill 随即变回禁用态，刚选的机器已经解释不通了。
    open(screen.getByTestId("task-pill-agent"));
    fireEvent.click(screen.getByTestId("task-agent-none"));
    fireEvent.click(screen.getByTestId("task-form-submit"));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues")).toMatchObject({
        agent_sync_id: "",
        agent_backend_sync_id: "",
        llm_provider_key: "",
        llm_model_key: "",
      });
    });
  });

  it("lists only the account's existing backends on the machine pill — the browser cannot create one", async () => {
    mockBoardApi();
    await renderBoard();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    open(await screen.findByTestId("task-pill-agent"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Alice/ }));

    open(await screen.findByTestId("board-exec-target-pill"));
    const rows = await screen.findAllByTestId(/^board-exec-target-row-/);

    // 「跟随 Agent 绑定」+ 账号里已有的两个后端，再没有第四行可点。
    expect(rows).toHaveLength(backends.length + 1);
    expect(rows.some((row) => row.textContent?.includes("Claude Code"))).toBe(
      true,
    );
    expect(screen.queryByTestId("board-exec-target-create")).toBeNull();
  });

  // 钉住的那台机器在别处被删掉了：pill 早就画成「跟随 Agent 绑定」（清单里找不到
  // 它），值却还是那个已经消失的标识，保存时服务端按引用核对直接拒，而界面上没有
  // 任何一个字段能让用户改正。
  it("drops a pin whose backend is gone from the account, so the save is not rejected on a dead reference", async () => {
    mockBoardApi();
    await renderBoard();

    // 这张卡钉着 backend-9，账号的后端清单里没有它。
    fireEvent.click(
      within(screen.getByTestId("board-column-todo")).getByText(
        "Fix the login redirect",
      ),
    );
    await screen.findByTestId("task-form");
    fireEvent.click(screen.getByTestId("task-form-submit"));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues/update")).toMatchObject({
        agent_backend_sync_id: "",
      });
    });
  });
});

describe("label management", () => {
  it("creates a label through the labels endpoint", async () => {
    mockBoardApi();
    await renderBoard();

    open(screen.getByTestId("filter-trigger"));
    fireEvent.click(await screen.findByTestId("filter-manage-labels"));
    fireEvent.change(await screen.findByTestId("label-new-name"), {
      target: { value: "infra" },
    });
    fireEvent.click(screen.getByTestId("label-create"));

    await waitFor(() => {
      expect(lastWrite("/v1/workspace/issues/labels")).toMatchObject({
        name: "infra",
      });
    });
  });
});
