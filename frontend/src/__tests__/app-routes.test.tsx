import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "@/App";
import i18n from "@/i18n";

// 见 auth-layout.test.tsx 顶部注释：绕开与本任务无关的 jsdom/Node localStorage 环境缺陷。
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
