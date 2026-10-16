import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />, { wrapper: ThemeProvider });
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

  // 那串数字是装饰（aria-hidden），但它仍是一屏里最大的字：用边框色画对比度太低、
  // 几乎看不见。它是文字，就用文字角色里最弱的那一档。
  it("draws the decorative 404 in the muted text colour, not a border colour", () => {
    renderAt("/this-route-does-not-exist");
    const code = screen.getByText("404");
    expect(code.getAttribute("aria-hidden")).toBe("true");
    expect(code.className).toMatch(/\btext-muted-foreground\b/);
    expect(code.className).not.toMatch(/\btext-border/);
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
