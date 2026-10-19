import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import Device from "@/pages/Device";
import { edgeClasses } from "./helpers/edge-classes";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.history.replaceState({}, "", "/device");
  vi.mocked(api).mockReset();
  vi.mocked(api).mockRejectedValue(new Error("unexpected call"));
});

describe("Device code-entry card", () => {
  it("is a sheet card with a large radius and a shadow, no edge, on chrome", () => {
    const { container } = render(
      <MemoryRouter>
        <Device />
      </MemoryRouter>,
      { wrapper: ThemeProvider },
    );
    expect(container.firstElementChild!.className).toMatch(/\bbg-chrome\b/);
    const card = container.querySelector("main > div")!;
    expect(card.className).toMatch(/\bbg-sheet\b/);
    expect(card.className).toMatch(/\brounded-2xl\b/);
    expect(card.className).toMatch(/\bshadow-overlay\b/);
    expect(edgeClasses(container)).toEqual([]);
  });
});
