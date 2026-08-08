import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "@/App";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  // main.tsx 里 App 就是套在 ThemeProvider 下的，这里照搬同一层。
  return render(<App />, { wrapper: ThemeProvider });
}

describe("App shell wiring", () => {
  it("mounts AppControls exactly once, inside the routed shell rather than outside Routes", async () => {
    await i18n.changeLanguage("en");
    renderAt("/login");
    expect(screen.getAllByRole("button", { name: /Language/i })).toHaveLength(
      1,
    );
  });

  it.each(["/terms", "/privacy", "/status"])(
    "serves %s publicly with the shared shell and a coming-soon placeholder",
    async (path) => {
      await i18n.changeLanguage("en");
      const { unmount } = renderAt(path);
      expect(await screen.findByText(i18n.t("legal.comingSoon"))).toBeTruthy();
      expect(screen.getByRole("banner")).toBeTruthy();
      expect(screen.getByRole("contentinfo")).toBeTruthy();
      unmount();
    },
  );
});
