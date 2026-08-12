import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "@/App";
import { api } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

// useMe / RequireAuth 需要的已登录会话；顶层 `/` 与 `/device` 都在 RequireAuth 之下。
const signedInMe = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

function mockSignedIn() {
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/auth/me") return signedInMe;
    if (path === "/v1/workspace/agents") return { agents: [] };
    throw new Error(`unexpected api call: ${path}`);
  });
}

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

  describe("root redirect", () => {
    it("lands a signed-in user at / on the console overview, not the device-code entry", async () => {
      await i18n.changeLanguage("en");
      mockSignedIn();
      renderAt("/");
      // RequireAuth 通过后应落在 /overview 控制台，而不是设备授权码输入页。
      expect(
        await screen.findByRole("heading", { level: 1, name: /Agents/i }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
    });

    it("serves /audit with the real Audit page (honest empty states), not the coming-soon placeholder", async () => {
      await i18n.changeLanguage("en");
      mockSignedIn();
      renderAt("/audit");
      // 真实 Audit 页(诚实空态),不是 WorkspaceComingSoon 占位页。
      expect(await screen.findByTestId("audit-events-empty")).toBeTruthy();
      expect(screen.getByTestId("audit-credentials-empty")).toBeTruthy();
    });

    it("still serves /device directly as the device-code entry", async () => {
      await i18n.changeLanguage("en");
      mockSignedIn();
      renderAt("/device");
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: /Enter the device code/i,
        }),
      ).toBeTruthy();
    });
  });
});
