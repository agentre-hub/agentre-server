/**
 * 控制台外壳（任务 2，正式节点 R969Y/ZC7pI）：
 *   - 桌面 SideNav：Brand（logo + AgentRe + 「控制台」副标）+ 非交互搜索外观 +
 *     4 个导航项（经由共享 ConsoleNavItem 渲染）+ 底部账号区。
 *   - 搜索无真实能力：外观不可聚焦（不是 button/input，无 tabindex）、
 *     不暗示可用快捷键（无 ⌘K）。
 *   - 审计不渲染伪蓝点：没有真实审计数据，nav 里不得有蓝点暗示新事件。
 *   - TopBar：title 槽（可选）+ right 槽（可选）+ AppControls；不传 title 时左侧空。
 *   - 锦上添花数据：/v1/follows、/v1/devices、/v1/auth/me 取不到就隐藏对应元素，
 *     不阻塞整体渲染（无数据态）。
 */
import { render, screen, within } from "@testing-library/react";
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

const REAL_NAV = ["Overview", "Chat", "Devices", "Audit"];

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

describe("桌面 SideNav（任务 2 外壳，R969Y）", () => {
  it("Brand：logo + AgentRe + 控制台副标", async () => {
    renderShell();
    expect(screen.getByText("AgentRe")).toBeTruthy();
    expect(screen.getByText("Console")).toBeTruthy();
  });

  it("搜索外观：非交互（不是 button、无 tabindex）、无 ⌘K 快捷键暗示", async () => {
    renderShell();
    // 占位文案还在（视觉外观保留），但不再是一个可聚焦控件。
    const placeholder = screen.getByText("Search agents, devices, and records");
    const box = placeholder.closest("div")!;
    expect(box.hasAttribute("tabindex")).toBe(false);
    expect(box.closest("button")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Search agents, devices, and records",
      }),
    ).toBeNull();
    expect(screen.queryByText("⌘K")).toBeNull();
    expect(screen.queryByText("⌘")).toBeNull();
  });

  it("4 个导航项经由共享 ConsoleNavItem 渲染（文案在 item 内层 span，链接本身不带字阶）", async () => {
    renderShell();
    for (const label of REAL_NAV) {
      const link = screen.getByRole("link", { name: label });
      // ConsoleNavItem 把 13px 字阶放在内层 label span，而不是链接类上。
      expect(link.className).not.toContain("text-[13px]");
      expect(within(link).getByText(label).className).toContain("text-[13px]");
    }
  });

  it("无数据态：对话 Badge、设备 Meta、账号区全部隐藏，不阻塞渲染", async () => {
    renderShell();
    await screen.findByText("Console");
    expect(screen.queryByText("Personal · Free")).toBeNull();
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
    expect(screen.queryByText("Dev User")).toBeNull();
    expect(screen.getByText("page content")).toBeTruthy();
  });

  it("有数据：对话 Badge=关注数、设备 Meta=agentred 在线/全部、账号区", async () => {
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

  it("审计导航项不渲染伪蓝点（无真实审计数据）", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      throw new Error("unexpected: " + path);
    });
    renderShell();
    await screen.findByText("Dev User");
    const audit = screen.getByRole("link", { name: "Audit" });
    // ConsoleNavItem 的 dot 是 aria-hidden 的 span；审计没有真实数据不得出现。
    expect(audit.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it("桌面无汉堡按钮、无抽屉", async () => {
    renderShell();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
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
