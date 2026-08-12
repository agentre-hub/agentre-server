/**
 * 移动端主导航（任务 2，正式节点 A6Z3k）：底部 TabBar 取代原抽屉。
 *   - 移动：不渲染桌面固定侧栏、无汉堡按钮、无抽屉/dialog；底部是
 *     MobileTabBar（h-[74px]，A6Z3k），只含真实可达目的地
 *     （Overview/Chat/Devices/Audit），不伪造「我」入口。
 *   - 移动：账号、语言与主题控制仍可达（账号进 TopBar，AppControls 在 TopBar）。
 *   - 移动：审计 tab 不渲染伪蓝点。
 *   - 桌面：保持固定侧栏，不渲染底部 TabBar。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  // 默认无数据：账号区不出现（不伪造）。
  mockedApi.mockRejectedValue(new Error("network down"));
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

function renderShell(initial = "/chat") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <ThemeProvider>
        <AppShell>
          <div>page content</div>
        </AppShell>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("移动端底部导航（A6Z3k，取代原抽屉）", () => {
  it("移动:无固定侧栏、无汉堡按钮、无抽屉；底部是 MobileTabBar", async () => {
    mockMobileViewport();
    renderShell();

    // 唯一一个导航就是底部 TabBar（A6Z3k h-[74px]）。
    const nav = screen.getByRole("navigation");
    expect(nav.className).toContain("h-[74px]");
    // 原抽屉相关控件全部消失。
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close menu" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // 页面主体照常渲染。
    expect(screen.getByText("page content")).toBeTruthy();
  });

  it("移动:底部 TabBar 只含真实目的地（Overview/Chat/Devices/Audit），不伪造「我」", async () => {
    mockMobileViewport();
    renderShell();

    for (const label of ["Overview", "Chat", "Devices", "Audit"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    // A6Z3k 的「我」tab 没有真实页面，不得作为目的地出现。
    expect(screen.queryByRole("link", { name: "Me" })).toBeNull();
    expect(screen.queryByText("Me")).toBeNull();
  });

  it("移动:当前 tab 高亮（primary-text）", async () => {
    mockMobileViewport();
    renderShell("/chat");

    const chat = screen.getByRole("link", { name: "Chat" });
    expect(chat.className).toContain("text-primary-text");
    const devices = screen.getByRole("link", { name: "Devices" });
    expect(devices.className).toContain("text-subtle-foreground");
  });

  it("移动:账号、语言与主题仍可达（账号进 TopBar，AppControls 在 TopBar）", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      throw new Error("unexpected: " + path);
    });
    renderShell();

    // 账号（TopBar 内的头像 + 名字）可达。
    expect(await screen.findByText("Dev User")).toBeTruthy();
    expect(screen.getByText("D")).toBeTruthy();
    // 语言 / 主题控制可达。
    expect(screen.getByRole("button", { name: /Language/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Theme/i })).toBeTruthy();
  });

  it("移动:审计 tab 不渲染伪蓝点", async () => {
    mockMobileViewport();
    renderShell();

    const audit = screen.getByRole("link", { name: "Audit" });
    expect(audit.querySelector('span[aria-hidden="true"]')).toBeNull();
  });
});

describe("桌面端导航（非移动）", () => {
  it("保持固定侧栏，无底部 TabBar", async () => {
    renderShell();

    const nav = screen.getByRole("navigation");
    // 桌面侧栏 224px，不是 74px 的 TabBar。
    expect(nav.className).toContain("w-[224px]");
    for (const label of ["Overview", "Chat", "Devices", "Audit"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    // 桌面不该出现底部 TabBar（h-[74px] 导航）。
    const navs = screen.getAllByRole("navigation");
    for (const n of navs) {
      expect(n.className).not.toContain("h-[74px]");
    }
  });
});
