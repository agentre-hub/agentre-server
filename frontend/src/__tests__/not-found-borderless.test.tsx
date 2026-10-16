import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "@/App";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { edgeClasses } from "./helpers/edge-classes";

describe("NotFound without structural lines", () => {
  it("is on a chrome page and draws no edge", () => {
    window.history.pushState({}, "", "/nope-not-a-route");
    const { container } = render(<App />, { wrapper: ThemeProvider });
    expect(container.firstElementChild!.className).toMatch(/\bbg-chrome\b/);
    expect(edgeClasses(container)).toEqual([]);
  });
});
