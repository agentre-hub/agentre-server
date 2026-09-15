import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import AuthLayout from "@/components/AuthLayout";
import { agentreLogoUrl, ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";

function renderLayout(children: ReactNode = <p>content</p>) {
  return render(
    <MemoryRouter>
      <AuthLayout>{children}</AuthLayout>
    </MemoryRouter>,
    // 顶栏里的 AppControls 要从 context 取主题，所以套真的 ThemeProvider。
    // jsdom 缺的 localStorage / matchMedia 由 src/test/setup.ts 补齐。
    { wrapper: ThemeProvider },
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("AuthLayout", () => {
  it("puts the brand mark and both controls in a document-flow top bar, not a fixed overlay", () => {
    renderLayout();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Agentre")).toBeTruthy();
    expect(
      within(banner).getByRole("button", { name: /Language/i }),
    ).toBeTruthy();
    expect(within(banner).getByRole("button", { name: /Theme/i })).toBeTruthy();
    expect(banner.className).not.toMatch(/\bfixed\b/);
  });

  // 顶栏这枚标跟侧边栏 Brand 带是同一份共享 mark，不是通用图标垫一块底板：
  // 登录页是没登录的人第一眼看到的界面，摆个终端图标等于第一眼就不是这个产品。
  it("brands the top bar with the shared Agentre mark rather than a generic glyph on a plate", () => {
    renderLayout();
    const banner = screen.getByRole("banner");
    const mark = within(banner).getByRole("presentation", { hidden: true });

    expect(mark.tagName).toBe("IMG");
    expect(mark.getAttribute("src")).toBe(agentreLogoUrl);
    expect(banner.innerHTML).not.toContain("bg-primary");
  });

  it("renders the given content inside a centred main region", () => {
    renderLayout(<p>page body</p>);
    const main = screen.getByRole("main");
    expect(within(main).getByText("page body")).toBeTruthy();
  });

  it("renders a footer with copyright and links to /terms, /privacy, /status", () => {
    renderLayout();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText(/Agentre/)).toBeTruthy();
    expect(
      within(footer)
        .getByRole("link", { name: "Terms of Service" })
        .getAttribute("href"),
    ).toBe("/terms");
    expect(
      within(footer)
        .getByRole("link", { name: "Privacy Policy" })
        .getAttribute("href"),
    ).toBe("/privacy");
    expect(
      within(footer).getByRole("link", { name: "Status" }).getAttribute("href"),
    ).toBe("/status");
  });
});
