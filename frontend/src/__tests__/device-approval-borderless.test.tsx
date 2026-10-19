import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import DeviceApproval from "@/components/DeviceApproval";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { edgeClasses } from "./helpers/edge-classes";

vi.mock("@/hooks/use-me", () => ({ useMe: () => ({ me: null }) }));

function renderApproval(error: string | null = null) {
  return render(
    <MemoryRouter>
      <DeviceApproval
        code="ABCD-EFGH"
        info={{
          device_kind: "desktop",
          platform: "macOS",
          version: "v1",
          expires_in: 300,
        }}
        submitting={false}
        error={error}
        onApprove={() => {}}
        onDeny={() => {}}
        onExpire={() => {}}
      />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

describe("DeviceApproval without structural lines", () => {
  it("is a sheet card with large radius and shadow, no edge, with fill buttons", () => {
    const { container } = renderApproval("boom");
    const card = container.firstElementChild!;
    expect(card.className).toMatch(/\bbg-sheet\b/);
    expect(card.className).toMatch(/\brounded-2xl\b/);
    expect(card.className).toMatch(/\bshadow-overlay\b/);
    expect(edgeClasses(container)).toEqual([]);
    const deny = screen.getByRole("button", { name: /deny/i });
    expect(deny.className).toMatch(/\bbg-button-fill\b/);
    expect(deny.className).not.toMatch(/\bbg-card\b/);
    expect(deny.className).not.toMatch(/border-border/);
  });
});
