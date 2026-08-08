import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import { ThemeProvider } from "@/lib/theme";
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
