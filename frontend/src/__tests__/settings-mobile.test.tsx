import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Settings from "@/pages/Settings";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { createBrowserEngineSettingsPorts } from "@/lib/enginePorts";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);
const originalMatchMedia = window.matchMedia;

function setMobile(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const agentred = {
  id: 2,
  name: "Builder",
  display_name: "Build box",
  kind: "agentred",
  platform: "linux",
  version: "1.0.0",
  fingerprint: "agentred-b",
  last_seen_at: 2,
  status: 1,
  online: true,
  is_this_device: false,
};

const session = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

const provider = {
  provider_key: "anthropic-main",
  name: "Anthropic",
  type: "anthropic",
  base_url: "https://api.anthropic.com",
  masked_tail: "1234",
  default_model_key: "sonnet",
  enabled: true,
  models: [
    {
      model_key: "sonnet",
      model_id: "claude-sonnet-4",
      name: "Sonnet",
      enabled: true,
      context_window: 200000,
      max_output: 8192,
    },
  ],
};

const backend = {
  sync_id: "backend-1",
  name: "My claude",
  type: "claudecode",
  device_fingerprint: "agentred-b",
  provider_key: "",
  model_key: "",
  env_json: "{}",
  reasoning_effort: "",
  config: {},
  ref_count: 0,
  cli_by_device: [],
};

function Where() {
  const { search } = useLocation();
  return <span data-testid="where">{search}</span>;
}

function NavType() {
  return <span data-testid="nav-type">{useNavigationType()}</span>;
}

function renderSettings(url = "/settings") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ThemeProvider>
        <Settings />
        <Where />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  setMobile(true);
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/auth/me") return session;
    if (path.startsWith("/v1/agent-sessions?")) return { total: 0 };
    if (path === "/v1/devices") return { devices: [agentred] };
    if (path === "/v1/engine/providers") return { providers: [provider] };
    if (path === "/v1/engine/backends") return { backends: [backend] };
    if (path === "/v1/engine/cli-overlays") return { overlays: [] };
    throw new Error(`unexpected api call: ${path}`);
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("Settings on a phone", () => {
  it("opens on a grouped list instead of the segmented control", async () => {
    renderSettings();
    for (const name of [
      "LLM providers",
      "Agent backends",
      "Privacy",
      "Appearance",
      "Language",
    ]) {
      expect(await screen.findByRole("link", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("pins a full-bleed phone header outside the scrolling body", async () => {
    renderSettings();
    await screen.findByRole("link", { name: "Language" });
    // 统一的手机页头（2026-11-20 第 5 / 14 项）：不落进主区内边距、不随正文滚走。
    const header = screen.getByTestId("settings-header");
    expect(header.getAttribute("data-slot")).toBe("phone-page-header");
    expect(header.closest('[data-slot="phone-page-body"]')).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Language" })
        .closest('[data-slot="phone-page-body"]'),
    ).not.toBeNull();
  });

  it("drills into the provider list and its detail page, and back out", async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole("link", { name: "LLM providers" }));
    expect(screen.getByTestId("where").textContent).toBe("?section=providers");
    // 逐层进入的页面是「‹ · 标题 · 动作」：页面动作在页头里，不在正文顶上。
    const header = screen.getByTestId("settings-header");
    expect(
      await within(header).findByRole("button", { name: /New Provider/ }),
    ).toBeTruthy();

    fireEvent.click((await screen.findAllByText("Anthropic")).at(-1)!);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("id="),
    );
    expect(await screen.findByText("claude-sonnet-4")).toBeTruthy();
    // 详情层的页头标题是供应商名，不再挂「新增供应商」（2026-11-20 第 5 项）。
    const detailHeader = screen.getByTestId("settings-header");
    expect(
      within(detailHeader).getByRole("heading", { name: "Anthropic" }),
    ).toBeTruthy();
    expect(
      within(detailHeader).queryByRole("button", { name: /New Provider/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("where").textContent).toBe("?section=providers");
    expect(
      within(screen.getByTestId("settings-header")).getByRole("heading", {
        name: "LLM providers",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("where").textContent).toBe("");
    expect(screen.getByRole("link", { name: "Language" })).toBeTruthy();
  });

  it("going back up a level steps back through history instead of pushing the parent again", async () => {
    // 浏览器里 react-router 在 history.state.idx 记着位置：这里模拟「从列表点进来的」。
    window.history.replaceState({ idx: 1 }, "");
    try {
      render(
        <MemoryRouter
          initialEntries={["/settings", "/settings?section=providers"]}
          initialIndex={1}
        >
          <ThemeProvider>
            <Settings />
            <Where />
            <NavType />
          </ThemeProvider>
        </MemoryRouter>,
      );
      fireEvent.click((await screen.findAllByText("Anthropic")).at(-1)!);
      expect(await screen.findByText("claude-sonnet-4")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Back" }));

      expect(screen.getByTestId("where").textContent).toBe(
        "?section=providers",
      );
      expect(screen.getByTestId("nav-type").textContent).toBe("POP");
    } finally {
      window.history.replaceState(null, "");
    }
  });

  it("edits a backend on its own page rather than in a dialog", async () => {
    renderSettings("/settings?section=backends");
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit My claude" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("id="),
    );
    const form = await screen.findByRole("form");
    expect(screen.queryByRole("dialog")).toBeNull();
    // 规格「编辑后端」：设备显示备注名。
    expect(
      (await within(form).findAllByText(/Build box/)).length,
    ).toBeGreaterThan(0);
    expect(within(form).queryByText(/Builder/)).toBeNull();
  });

  it("switches language from the language page", async () => {
    renderSettings("/settings?section=language");
    fireEvent.click(await screen.findByRole("radio", { name: "简体中文" }));
    await waitFor(() => expect(i18n.resolvedLanguage).toBe("zh-CN"));
  });

  it("keeps the old ?tab=privacy deep link landing on privacy", async () => {
    renderSettings("/settings?tab=privacy");
    expect(
      await screen.findByRole("heading", { name: "Privacy" }),
    ).toBeTruthy();
  });
});

describe("Settings privacy on phone", () => {
  it("shows the cleanup section after the activity stats with a full-width action", async () => {
    setMobile(true);
    mockedApi.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p === "/v1/saved-sessions/cleanup/preview")
        return { count: 3, retained: 0, machines: [], conversation_ids: ["a"] };
      if (p === "/v1/workspace/agents") return { agents: [] };
      if (p === "/v1/workspace/projects") return { projects: [] };
      if (p === "/v1/stats/settings")
        return { activity_stats_enabled: true, devices: [] };
      return {};
    });
    renderSettings("/settings?tab=privacy");
    const clean = await screen.findByRole("button", {
      name: /Clean up 3 conversations/,
    });
    expect(clean.className).toMatch(/\bw-full\b/);
  });

  it("updates the saved-conversation count after a cleanup completes", async () => {
    setMobile(true);
    let reads = 0;
    mockedApi.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p === "/v1/saved-sessions/cleanup/preview")
        return {
          count: 2,
          retained: 0,
          machines: [],
          conversation_ids: ["a", "b"],
        };
      if (p === "/v1/saved-sessions/cleanup")
        return { deleted: 2, retained: 0, failed: [], pending: [] };
      if (p === "/v1/workspace/agents") return { agents: [] };
      if (p === "/v1/workspace/projects") return { projects: [] };
      if (p === "/v1/stats/settings") {
        reads += 1;
        return {
          activity_stats_enabled: true,
          devices: [],
          saved_conversations: reads === 1 ? 128 : 1,
        };
      }
      return {};
    });
    renderSettings("/settings?tab=privacy");
    const clean = await screen.findByRole("button", {
      name: /Clean up 2 conversations/,
    });
    await waitFor(() =>
      expect((clean as HTMLButtonElement).disabled).toBe(false),
    );
    expect(
      (await screen.findByTestId("privacy-saved-count")).textContent,
    ).toContain("128");
    fireEvent.click(clean);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Delete 2/ }));
    await waitFor(() =>
      expect(screen.getByTestId("privacy-saved-count").textContent).toMatch(
        /^1 conversation/,
      ),
    );
    expect(screen.getByTestId("privacy-saved-count").textContent).not.toContain(
      "128",
    );
  });
});

describe("Settings on desktop", () => {
  it("still shows the segmented control", async () => {
    setMobile(false);
    renderSettings();
    expect(await screen.findByRole("tab", { name: "Privacy" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Appearance" })).toBeNull();
  });
});

describe("engine ports device names", () => {
  const messages = {
    noOnlineAgentredReason: "",
    builtinUnsupportedReason: "",
    unsupportedBackendReason: "",
    deviceRequiredReason: "",
    deviceOfflineReason: "",
    deviceUnknownReason: "",
    credentialErrorReason: () => "",
  };

  it("by default (desktop) keeps the reported device name, as before", async () => {
    const ports = createBrowserEngineSettingsPorts(messages);
    const [listed] = await ports.listBackends();
    expect(listed.deviceName).toBe("Builder");
    const [device] = await ports.listAccountDevices!();
    expect(device.name).toBe("Builder");
  });

  it("with remark names (phone) labels a backend's device and the picker with its nickname", async () => {
    const ports = createBrowserEngineSettingsPorts(messages, {
      remarkNames: true,
    });
    const [listed] = await ports.listBackends();
    expect(listed.deviceName).toBe("Build box");
    const [device] = await ports.listAccountDevices!();
    expect(device.name).toBe("Build box");
  });
});
