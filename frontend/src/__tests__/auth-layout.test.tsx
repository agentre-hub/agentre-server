import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AuthLayout from "@/components/AuthLayout";
import i18n from "@/i18n";

// theme.tsx 的 readStored() 直接读 localStorage，在这台机器的 Node 版本下
// jsdom 的 window.localStorage 解析成 undefined（Node 自带的实验性 Storage
// 抢占了 jsdom 的实现，没配 --localstorage-file 就取不到值）——与本任务无关的
// 环境缺陷，且 lib/theme.tsx 不在本任务的可写路径内。这里只关心 AuthLayout 的
// 结构，所以把 useTheme 换成静态返回，绕开这层不相关的环境问题。
vi.mock("@/lib/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/theme")>();
  return {
    ...actual,
    useTheme: () => ({
      theme: "system" as const,
      resolved: "light" as const,
      setTheme: vi.fn(),
    }),
  };
});

function renderLayout(children: ReactNode = <p>content</p>) {
  return render(
    <MemoryRouter>
      <AuthLayout>{children}</AuthLayout>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("AuthLayout", () => {
  it("puts the brand mark and both controls in a document-flow top bar, not a fixed overlay", () => {
    renderLayout();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("AgentRe")).toBeTruthy();
    expect(
      within(banner).getByRole("button", { name: /Language/i }),
    ).toBeTruthy();
    expect(within(banner).getByRole("button", { name: /Theme/i })).toBeTruthy();
    expect(banner.className).not.toMatch(/\bfixed\b/);
  });

  it("renders the given content inside a centred main region", () => {
    renderLayout(<p>page body</p>);
    const main = screen.getByRole("main");
    expect(within(main).getByText("page body")).toBeTruthy();
  });

  it("renders a footer with copyright and links to /terms, /privacy, /status", () => {
    renderLayout();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText(/AgentRe/)).toBeTruthy();
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
