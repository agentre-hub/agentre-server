import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import App, { ChatPage, SessionDetailPage } from "@/App";
import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
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
    if (path === "/v1/workspace/projects") return { projects: [] };
    // 总览的统计取数；本文件只关心路由，给一份空账号的响应即可。
    if (path.startsWith("/v1/stats/overview"))
      return {
        activity_stats_enabled: false,
        scope: "saved",
        time_zone: "UTC",
        summary: {
          conversations: 0,
          conversations_total: 0,
          streak_days: 0,
          longest_streak_days: 0,
          active_days: 0,
          window_days: 30,
          devices_online: 0,
          devices_total: 0,
        },
        heatmap: { from: "2025-09-01", to: "2026-08-28", days: [] },
        agents: [],
        backends: [],
        models: [],
        projects: [],
      };
    if (path.startsWith("/v1/agent-sessions")) return { total: 0, items: [] };
    // /account 的两张清单卡；本文件只关心路由与导航是否正确，不关心卡内数据。
    if (path === "/v1/passkeys") return { passkeys: [] };
    if (path === "/v1/auth/sessions") return { sessions: [] };
    if (path === "/v1/engine/providers") return { providers: [] };
    if (path === "/v1/engine/backends") return { backends: [] };
    if (path === "/v1/devices") return { devices: [] };
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

  it("挂载后趁空闲预热对话两页：首次从别处切过去不再空屏一下", async () => {
    await i18n.changeLanguage("en");
    mockSignedIn();
    // 真去 import 会把 xterm / highlight.js 那一堆拉进这个用例；这里只认「有没有
    // 按空闲预热」这条接线，模块本身的契约在 lazy-page.test.tsx。
    const chat = vi.spyOn(ChatPage, "preload").mockResolvedValue();
    const detail = vi.spyOn(SessionDetailPage, "preload").mockResolvedValue();
    onTestFinished(() => {
      vi.restoreAllMocks();
    });

    renderAt("/overview");
    await screen.findByRole("group", { name: "Stats range" });

    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(detail).toHaveBeenCalledTimes(1);
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
      // 认的是总览独有的范围分段控件：这一页此前靠 Agent 卡那个 h1 指认，而那张卡
      // 已经换成以统计为主的版式，页面标题只剩顶栏那一处（与设备/对话/组织一致）。
      expect(
        await screen.findByRole("group", { name: "Stats range" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
    });

    it("does not serve /audit: the unused empty page is gone, so the catch-all 404 renders", async () => {
      await i18n.changeLanguage("en");
      mockSignedIn();
      renderAt("/audit");
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: /page not found/i,
        }),
      ).toBeTruthy();
      expect(screen.queryByTestId("audit-events-empty")).toBeNull();
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

    it("protects /account with RequireAuth and serves the real Account page for a signed-in user", async () => {
      await i18n.changeLanguage("en");
      mockSignedIn();
      renderAt("/account");
      // 三张卡里最先能取到数据的是账号卡（display_name 来自 /v1/auth/me）；
      // 通行密钥卡的空态标题确认渲染的是真实 Account 页，不是 NotFound/占位页。
      expect(
        await screen.findByText(signedInMe.email, { selector: "dd" }),
      ).toBeTruthy();
      expect(screen.getByText("No passkeys yet")).toBeTruthy();
    });

    it("protects /settings and serves the shared engine settings page", async () => {
      await i18n.changeLanguage("en");
      mockSignedIn();
      renderAt("/settings");

      expect(
        await screen.findByRole("heading", { level: 1, name: "Settings" }),
      ).toBeTruthy();
      expect(screen.getByRole("tab", { name: "LLM providers" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Agent backends" })).toBeTruthy();
    });

    it("adds the account-hosted key sync notice to the public privacy placeholder", async () => {
      await i18n.changeLanguage("en");
      renderAt("/privacy");
      expect(
        await screen.findByText(
          "API keys are hosted for your account and synced only to your own devices.",
        ),
      ).toBeTruthy();
    });

    it("does not add /account to the main navigation (only reachable from the account menu)", async () => {
      await i18n.changeLanguage("en");
      mockSignedIn();
      renderAt("/account");
      await screen.findByText("No passkeys yet");
      const nav = screen.getByRole("navigation");
      const hrefs = within(nav)
        .getAllByRole("link")
        .map((el: HTMLElement) => el.getAttribute("href"));
      expect(hrefs).not.toContain("/account");
    });
  });
});
