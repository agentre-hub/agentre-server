/**
 * 无边框改版 /issues 一页：页头与筛选条不再各自一条色带，执行目标选择器里没有结构线。
 * 看板、任务卡、表单本体是共享包的，由共享包自己的用例守；这里只钉宿主那一半。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import { api } from "@/lib/api";
import Issues from "@/pages/Issues";

import { edgeClasses } from "./helpers/edge-classes";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const backends = [
  {
    sync_id: "backend-1",
    name: "Claude Code",
    backend_type: "claude_code",
    device_name: "MacBook",
    device_unspecified: false,
    availability: "available",
  },
];

beforeEach(async () => {
  mockedApi.mockReset();
  await i18n.changeLanguage("en");
  mockedApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/workspace/issues"))
      return {
        issues: [],
        labels: [],
        stage_counts: { todo: 0, doing: 0, review: 0, done: 0 },
        stage_totals: { todo: 0, doing: 0, review: 0, done: 0 },
        project_counts: [],
      };
    if (path === "/v1/workspace/projects") return { projects: [] };
    if (path === "/v1/workspace/agents")
      return {
        agents: [
          {
            sync_id: "agent-alice",
            name: "Alice",
            avatar_color: "agent-3",
            has_available_target: true,
            exec_targets: [],
          },
        ],
      };
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
    return {};
  });
});

/** Radix 的 dropdown 开在 pointerdown 上，popover 开在 click 上：两下都发。 */
function open(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

async function renderBoard() {
  render(
    <MemoryRouter initialEntries={["/issues"]}>
      <Issues />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
  return screen.findByTestId("issues-page");
}

describe("/issues is borderless", () => {
  it("header and filter row sit on the sheet: no colour band, no rule", async () => {
    const page = await renderBoard();
    await screen.findByTestId("issue-board");

    const header = page.querySelector("header") as HTMLElement;
    expect(header).toBeTruthy();
    for (const band of [header, header.nextElementSibling as HTMLElement]) {
      expect(band.className).not.toMatch(/\bbg-(card|sidebar|background)\b/);
    }
    expect(edgeClasses(page)).toEqual([]);
  });

  it("the machine picker lists its rows with spacing, not rules", async () => {
    await renderBoard();
    fireEvent.click(screen.getAllByRole("button", { name: "New task" })[0]);
    // 机器 pill 在没选 Agent 时是禁用态；先选 Agent 再开。
    open(await screen.findByTestId("task-pill-agent"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Alice/ }));
    open(await screen.findByTestId("board-exec-target-pill"));
    const row = await screen.findByTestId("board-exec-target-row-follow");
    const popover = row.parentElement!.parentElement as HTMLElement;
    expect(edgeClasses(popover)).toEqual([]);
  });
});
