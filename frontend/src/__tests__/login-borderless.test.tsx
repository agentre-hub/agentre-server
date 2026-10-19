import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Login from "@/pages/Login";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import { edgeClasses } from "./helpers/edge-classes";

function renderLogin(search = "") {
  Object.defineProperty(window, "location", {
    value: { ...window.location, search, assign: vi.fn() },
    writable: true,
  });
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Login />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

/** 复选框保留边（规格硬约束），所以从扫描里摘掉它。 */
function edgesExceptCheckbox(root: Element): string[] {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[role="checkbox"]').forEach((el) => el.remove());
  return edgeClasses(clone);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  Object.defineProperty(window, "PublicKeyCredential", {
    value: class {},
    configurable: true,
    writable: true,
  });
  vi.spyOn(window, "isSecureContext", "get").mockReturnValue(true);
});

describe("Login without structural lines", () => {
  it("stands the card up as a sheet with a large radius and a shadow, on a chrome page", () => {
    const { container } = renderLogin();
    const card = screen.getByRole("heading", { level: 1 }).parentElement!;
    expect(card.className).toMatch(/\bbg-sheet\b/);
    expect(card.className).toMatch(/\brounded-2xl\b/);
    expect(card.className).toMatch(/\bshadow-overlay\b/);
    expect(card.className).not.toMatch(/\bbg-card\b/);
    expect(container.firstElementChild!.className).toMatch(/\bbg-chrome\b/);
  });

  it("draws no edge anywhere, including the 'or' separator", () => {
    const { container } = renderLogin();
    expect(screen.getByRole("button", { name: /passkey/i })).toBeTruthy();
    expect(screen.getByText(i18n.t("login.or"))).toBeTruthy();
    expect(edgesExceptCheckbox(container)).toEqual([]);
  });

  it("keeps the failure card free of edges too", () => {
    const { container } = renderLogin("?err=access_denied");
    expect(edgesExceptCheckbox(container)).toEqual([]);
  });
});
