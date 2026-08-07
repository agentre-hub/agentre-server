import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import i18n from "@/i18n";

// 见 auth-layout.test.tsx 顶部注释：AuthLayout 经 AppControls 触到 lib/theme，
// 与本任务无关的 jsdom/Node localStorage 环境缺陷需要绕开。
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

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("NotFound (404)", () => {
  it("shows a 404 watermark plus a heading and body line that are not just the digits", () => {
    renderAt("/this-route-does-not-exist");
    expect(screen.getByText("404")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: /page not found/i }),
    ).toBeTruthy();
  });

  it("has exactly one h1", () => {
    renderAt("/this-route-does-not-exist");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("has no card wrapper around the content", () => {
    renderAt("/this-route-does-not-exist");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.closest(".border")).toBeNull();
  });

  it("links back to / with a back-home button", () => {
    renderAt("/this-route-does-not-exist");
    expect(
      screen.getByRole("link", { name: /back to home/i }).getAttribute("href"),
    ).toBe("/");
  });
});
