import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import ComingSoon from "@/pages/ComingSoon";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { edgeClasses } from "./helpers/edge-classes";

describe("ComingSoon", () => {
  it("sits on a chrome page without any edge", () => {
    const { container } = render(
      <MemoryRouter>
        <ComingSoon page="privacy" />
      </MemoryRouter>,
      { wrapper: ThemeProvider },
    );
    expect(container.firstElementChild!.className).toMatch(/\bbg-chrome\b/);
    expect(edgeClasses(container)).toEqual([]);
  });
});
