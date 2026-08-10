import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";
import Overview from "@/pages/Overview";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

function renderOverview() {
  return render(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
});

describe("overview page", () => {
  it("lists agents with ordered exec targets, the current one, and per-target reasons", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") {
        return {
          agents: [
            {
              sync_id: "agent-1",
              name: "Frontend Agent",
              department_name: "Engineering",
              has_available_target: true,
              exec_targets: [
                {
                  rank: 1,
                  is_local_reference: true,
                  availability: "skipped_for_web",
                  current: false,
                },
                {
                  rank: 2,
                  is_local_reference: false,
                  device_id: 20,
                  device_name: "Study NUC",
                  backend_type: "claude_code",
                  availability: "offline",
                  current: false,
                },
                {
                  rank: 3,
                  is_local_reference: false,
                  device_id: 21,
                  device_name: "Office Mac mini",
                  backend_type: "codex",
                  availability: "available",
                  current: true,
                },
              ],
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderOverview();

    expect(await screen.findByText("Frontend Agent")).toBeTruthy();
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(
      screen.getByText(/Currently running on Office Mac mini/),
    ).toBeTruthy();

    expect(screen.getByText("Skipped for web dispatch")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Study NUC/)).toBeTruthy();

    // 「Office Mac mini」出现两处：「当前落到」那句摘要，以及执行目标链里的
    // 那个 chip。「当前生效」那一档要能从视觉上区分出来（不只是靠颜色）——
    // 断言链里那个 chip 携带一个可查询的 current 标记，而不是只看 CSS 类名。
    const matches = screen.getAllByText(/Office Mac mini/);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const currentChip = matches
      .map((el) => el.closest('[data-current="true"]'))
      .find(Boolean);
    expect(currentChip).toBeTruthy();
  });

  it("shows the no-available-target banner when an agent has none", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") {
        return {
          agents: [
            {
              sync_id: "agent-2",
              name: "QA Agent",
              has_available_target: false,
              exec_targets: [
                {
                  rank: 1,
                  is_local_reference: false,
                  backend_type: "claude_code",
                  availability: "unpaired",
                  current: false,
                },
              ],
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderOverview();

    expect(await screen.findByText("QA Agent")).toBeTruthy();
    expect(screen.getByText("No available execution target")).toBeTruthy();
    expect(screen.getByText("Not paired")).toBeTruthy();
  });

  it("shows the empty state when the account has no agents", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") return { agents: [] };
      throw new Error("unexpected call: " + path);
    });

    renderOverview();

    expect(await screen.findByText("No agents yet.")).toBeTruthy();
  });

  it("reports a load failure instead of rendering the empty state", async () => {
    mockedApi.mockImplementation(async () => {
      throw new SyntaxError("Unexpected token '<' ... is not valid JSON");
    });

    renderOverview();

    expect(
      await screen.findByText("Could not load your agents. Please try again."),
    ).toBeTruthy();
    expect(screen.queryByText("No agents yet.")).toBeNull();
  });

  // R19 守卫：即便 API 响应里意外混进了路径/CLIPath/EnvJSON 形状的字段
  // （生产环境本不该发生——这里模拟的是「万一后端回归」），页面渲染出的文本里
  // 也绝不能出现它们。这道断言钉的是渲染输出，而不是信任后端已经把关。
  it("never renders a path, cli_path or env_json value even if the response carries one", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/workspace/agents") {
        return {
          agents: [
            {
              sync_id: "agent-3",
              name: "Ops Agent",
              has_available_target: true,
              exec_targets: [
                {
                  rank: 1,
                  is_local_reference: false,
                  device_id: 20,
                  device_name: "Study NUC",
                  backend_type: "claude_code",
                  availability: "available",
                  current: true,
                  // 下面三个字段真实的 API 从不会发；这里故意塞进去，
                  // 断言组件即便拿到了也绝不会把它们画出来。
                  path: "/Users/wyz/secret-project",
                  cli_path: "/usr/local/bin/claude",
                  env_json: '{"OPENAI_API_KEY":"sk-super-secret"}',
                },
              ],
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    const { container } = renderOverview();
    await waitFor(() => expect(screen.getByText("Ops Agent")).toBeTruthy());

    const text = container.textContent ?? "";
    expect(text).not.toContain("/Users/wyz");
    expect(text).not.toContain("/usr/local/bin/claude");
    expect(text).not.toContain("sk-super-secret");
    expect(text).not.toContain("cli_path");
    expect(text).not.toContain("env_json");
  });
});
