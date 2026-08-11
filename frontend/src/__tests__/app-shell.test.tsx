/**
 * 控制台外壳（任务 2 服务的外壳需求）：
 *   - 桌面 SideNav：Brand（logo + AgentRe + 「控制台」副标）+ ⌘K 搜索框 + 4 导航项
 *     （对话带关注数 Badge、设备带在线/全部 Meta、审计带蓝点）+ 底部账号区。
 *   - TopBar：title 槽（可选）+ right 槽（可选）+ AppControls；不传时左侧空、右侧仍 AppControls。
 *   - 锦上添花数据：/v1/follows、/v1/devices、/v1/auth/me 取不到就隐藏对应元素，
 *     不阻塞整体渲染（无数据态）。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "@/components/AppShell";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const me = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev User",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

const follows = [
  { device_fingerprint: "fp-1", session_id: "1" },
  { device_fingerprint: "fp-1", session_id: "2" },
  { device_fingerprint: "fp-2", session_id: "3" },
];

const devices = [
  { id: 1, kind: "agentred", online: true },
  { id: 2, kind: "agentred", online: true },
  { id: 3, kind: "agentred", online: false },
  { id: 4, kind: "browser", online: true },
];

function renderShell(
  ui: React.ReactElement = <AppShell>page content</AppShell>,
) {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <ThemeProvider>{ui}</ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  // 默认：所有请求都失败 → 无数据态（接口不可用 / 未登录都不让外壳崩）。
  mockedApi.mockRejectedValue(new Error("network down"));
});

describe("桌面 SideNav（任务 2 外壳）", () => {
  it("Brand：logo + AgentRe + 控制台副标", async () => {
    renderShell();
    expect(screen.getByText("AgentRe")).toBeTruthy();
    expect(screen.getByText("Console")).toBeTruthy();
  });

  it("⌘K 搜索框：键盘可达 button + aria-label + 占位与快捷键", async () => {
    renderShell();
    const btn = screen.getByRole("button", {
      name: "Search agents, devices, and records",
    });
    expect(btn).toBeTruthy();
    expect(btn.querySelector("kbd")?.textContent).toBe("⌘K");
  });

  it("无数据态：对话 Badge、设备 Meta、账号区全部隐藏，不阻塞渲染", async () => {
    renderShell();
    // 先等外壳渲染稳定（请求都已 settle），再断言三个锦上添花元素都不出现。
    await screen.findByText("Console");
    expect(screen.queryByText("Personal · Free")).toBeNull();
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
    expect(screen.queryByText("Dev User")).toBeNull();
    // 页面主体照常渲染。
    expect(screen.getByText("page content")).toBeTruthy();
  });

  it("有数据：对话 Badge=关注数、设备 Meta=agentred 在线/全部、审计蓝点、账号区", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/follows") return { items: follows };
      if (path === "/v1/devices") return { devices };
      throw new Error("unexpected: " + path);
    });
    renderShell();
    expect(await screen.findByText("3")).toBeTruthy(); // 关注数 Badge
    expect(screen.getByText("2/3")).toBeTruthy(); // agentred 在线/全部
    expect(screen.getByText("Dev User")).toBeTruthy(); // 账号名
    expect(screen.getByText("Personal · Free")).toBeTruthy(); // 账号 Meta
    expect(screen.getByText("D")).toBeTruthy(); // 首字母头像
  });
});

describe("TopBar（任务 2）", () => {
  it("title 传入时渲染在标题槽", async () => {
    renderShell(<AppShell title="Page Title">body</AppShell>);
    expect(screen.getByText("Page Title")).toBeTruthy();
  });

  it("不传 title 时标题槽为空，右侧仍渲染 AppControls", async () => {
    renderShell();
    expect(screen.queryByText("Page Title")).toBeNull();
    expect(screen.getByRole("button", { name: /Language/i })).toBeTruthy();
  });

  it("right 槽位：传入的 ReactNode 渲染在 AppControls 旁", async () => {
    renderShell(
      <AppShell right={<button>Custom Action</button>}>body</AppShell>,
    );
    expect(screen.getByRole("button", { name: "Custom Action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Language/i })).toBeTruthy();
  });
});
