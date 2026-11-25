/**
 * 新建任务超时（规格 2026-11-25 F5 看板部分、W13）：请求发出去了、可能已经建好。
 * 错误块只写「网络超时，可能已经建好了」+「刷新看看」，不露英文原文；点「刷新看看」先
 * 重读看板——认得出刚提交的那条就直接打开它，认不出才允许再提交；刷新在途不能再发
 * 第二个 POST。
 *
 * 认的规则：重读结果里有一条「提交前看板上没有的 sync_id」，且标题（去空白）、项目、
 * Agent 与用户提交的一致。同名旧任务因此不会被误认，时钟偏差也不影响。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import { api, ApiTimeoutError } from "@/lib/api";
import Issues from "@/pages/Issues";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } };
});

const mockedApi = vi.mocked(api);
const originalMatchMedia = window.matchMedia;

const issue = (id: string, title: string) => ({
  sync_id: id,
  title,
  description: "",
  stage: "todo",
  position: 1,
  project_sync_id: "",
  closed_at: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_100_000,
  labels: [],
});

let serverIssues: ReturnType<typeof issue>[] = [];
/** 非空时，下一次看板读等它放行（模拟刷新在途）。 */
let gate: Promise<void> | null = null;
let boardReadFails = false;

const boardOf = () => ({
  issues: serverIssues,
  labels: [],
  stage_counts: { todo: serverIssues.length, doing: 0, review: 0, done: 0 },
  stage_totals: { todo: serverIssues.length, doing: 0, review: 0, done: 0 },
  project_counts: [],
});

const creates = () =>
  mockedApi.mock.calls.filter(
    ([p, init]) =>
      p === "/v1/workspace/issues" && (init as RequestInit)?.method === "POST",
  );

async function renderBoard(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      throw new ApiTimeoutError(path, 15_000);
    }
    if (path.startsWith("/v1/workspace/issues")) {
      if (gate) await gate;
      if (boardReadFails) throw new Error("offline");
      return boardOf();
    }
    if (path === "/v1/workspace/projects") return { projects: [] };
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

/** 打开新建表单、填标题、提交，等到超时那一行出来。 */
async function submitUntilTimeout(title = "Phone task") {
  fireEvent.click(screen.getAllByRole("button", { name: "New task" })[0]);
  fireEvent.change(await screen.findByTestId("task-title"), {
    target: { value: title },
  });
  fireEvent.click(screen.getByTestId("task-form-submit"));
  await screen.findByTestId("task-form-error");
}

const refreshButton = () =>
  screen.getByRole("button", { name: "Refresh to check" });

beforeEach(async () => {
  serverIssues = [issue("iss-old", "Old one")];
  gate = null;
  boardReadFails = false;
  mockedApi.mockReset();
  vi.mocked(toast.error).mockReset();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe.each([
  ["手机", true],
  ["桌面", false],
])("新建任务超时 · %s", (_name, phone) => {
  it("只写一行说明 + 刷新按钮，不露请求超时的英文原文", async () => {
    await renderBoard(phone);
    await submitUntilTimeout();

    const error = screen.getByTestId("task-form-error");
    expect(error.textContent).not.toMatch(/request timed out after/i);
    expect(error.textContent).toMatch(/may already have been created/i);
    expect(refreshButton()).toBeTruthy();
  });

  it("刷新后认出刚提交的那条：直接打开它，不再 POST", async () => {
    await renderBoard(phone);
    await submitUntilTimeout();
    serverIssues = [issue("iss-new", "Phone task"), ...serverIssues];

    fireEvent.click(refreshButton());

    await waitFor(() =>
      expect(screen.getByTestId("task-title")).toHaveProperty(
        "value",
        "Phone task",
      ),
    );
    // 表单换成了「编辑这条」：面包屑不再是「新建任务」，超时那一行也没了。
    expect(screen.getByTestId("task-form-breadcrumb").textContent).not.toMatch(
      /New task/,
    );
    expect(screen.queryByTestId("task-form-error")).toBeNull();
    expect(creates()).toHaveLength(1);
  });

  it("刷新后没有这一条：留在表单、允许再提交", async () => {
    await renderBoard(phone);
    await submitUntilTimeout();

    fireEvent.click(refreshButton());
    await waitFor(() =>
      expect(
        mockedApi.mock.calls.filter(([p]) =>
          String(p).startsWith("/v1/workspace/issues?"),
        ).length +
          mockedApi.mock.calls.filter(([p]) => p === "/v1/workspace/issues")
            .length,
      ).toBeGreaterThan(2),
    );

    const submit = screen.getByTestId("task-form-submit");
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    await waitFor(() => expect(creates()).toHaveLength(2));
  });

  it("同名的旧任务不算：提交前就在板上的那条不会被认成刚建的", async () => {
    serverIssues = [issue("iss-old", "Phone task")];
    await renderBoard(phone);
    await submitUntilTimeout("Phone task");

    fireEvent.click(refreshButton());

    await waitFor(() =>
      expect(screen.getByTestId("task-form-submit")).toHaveProperty(
        "disabled",
        false,
      ),
    );
    expect(screen.getByTestId("task-form-breadcrumb").textContent).toMatch(
      /New task/,
    );
  });

  it("刷新本身失败：说一声、表单留着、不自动重发", async () => {
    await renderBoard(phone);
    await submitUntilTimeout();
    boardReadFails = true;

    fireEvent.click(refreshButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByTestId("task-form")).toBeTruthy();
    expect(creates()).toHaveLength(1);
  });

  it("刷新在途时再点提交不发第二个 POST；等刷新认出来就直接打开", async () => {
    await renderBoard(phone);
    await submitUntilTimeout();
    serverIssues = [issue("iss-new", "Phone task"), ...serverIssues];
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));

    fireEvent.click(refreshButton());
    fireEvent.click(screen.getByTestId("task-form-submit"));
    await Promise.resolve();
    expect(creates()).toHaveLength(1);

    release();
    await waitFor(() =>
      expect(
        screen.getByTestId("task-form-breadcrumb").textContent,
      ).not.toMatch(/New task/),
    );
    expect(creates()).toHaveLength(1);
  });
});
