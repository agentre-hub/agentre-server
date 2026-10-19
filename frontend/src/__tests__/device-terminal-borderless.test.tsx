import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import DeviceSuccess from "@/pages/DeviceSuccess";
import DeviceDenied from "@/pages/DeviceDenied";
import DeviceExpired from "@/pages/DeviceExpired";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { edgeClasses } from "./helpers/edge-classes";

function renderScreen(ui: ReactElement, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/x", state }]}>
      {ui}
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

const info = { kind: "desktop", platform: "macOS", version: "15.2" };

describe.each([
  ["DeviceSuccess", <DeviceSuccess key="s" />, info],
  ["DeviceDenied", <DeviceDenied key="d" />, undefined],
  ["DeviceExpired", <DeviceExpired key="e" />, undefined],
])("%s without structural lines", (_name, ui, state) => {
  it("is a sheet card with large radius and shadow on chrome, no edge", () => {
    const { container } = renderScreen(ui, state);
    expect(container.firstElementChild!.className).toMatch(/\bbg-chrome\b/);
    const card = container.querySelector("main > div")!;
    expect(card.className).toMatch(/\bbg-sheet\b/);
    expect(card.className).toMatch(/\brounded-2xl\b/);
    expect(card.className).toMatch(/\bshadow-overlay\b/);
    expect(edgeClasses(container)).toEqual([]);
  });
});
