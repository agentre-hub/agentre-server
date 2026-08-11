/**
 * 移动端导航抽屉（屏 29）：固定左侧栏换成汉堡按钮 + 抽屉。
 *   - 移动：不渲染固定侧栏，渲染「打开菜单」汉堡按钮；点开出现含全部导航项的抽屉。
 *   - 点关闭按钮 / 点导航项后抽屉关闭。
 *   - 桌面：保持固定侧栏，无汉堡按钮。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import AppShell from "@/components/AppShell";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";

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
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <ThemeProvider>
        <AppShell>
          <div>page content</div>
        </AppShell>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("移动端导航抽屉(屏 29)", () => {
  it("移动:不渲染固定侧栏,渲染汉堡按钮;点开抽屉,展示全部导航项", async () => {
    mockMobileViewport();
    renderShell();

    // 没有固定侧栏(role=navigation 由桌面侧栏独占)。
    expect(screen.queryByRole("navigation")).toBeNull();
    const openBtn = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(openBtn);

    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(dialog).toBeTruthy();
    for (const item of ["Overview", "Chat", "Devices", "Audit"]) {
      expect(screen.getByRole("link", { name: item })).toBeTruthy();
    }
    // 抽屉内容随新 SideNav：Brand 副标 + ⌘K 搜索框；账号数据取不到时整行隐藏。
    expect(screen.getByText("Console")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Search agents, devices, and records",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Personal · Free")).toBeNull();
  });

  it("移动:点关闭按钮后抽屉关闭", async () => {
    mockMobileViewport();
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Close menu" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("移动:点抽屉里的导航项后抽屉关闭", async () => {
    mockMobileViewport();
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Devices" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("桌面端导航(非移动)", () => {
  it("保持固定侧栏,无汉堡按钮", async () => {
    renderShell();

    expect(screen.getByRole("navigation")).toBeTruthy();
    for (const item of ["Overview", "Chat", "Devices", "Audit"]) {
      expect(screen.getByRole("link", { name: item })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });
});
