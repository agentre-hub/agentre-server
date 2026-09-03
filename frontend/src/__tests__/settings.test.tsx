import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Settings from "@/pages/Settings";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

// 一台真实登记的执行端设备：Agent 后端页要有它才提供新建入口（规格决策 10）。
const session = {
  user_id: 1,
  email: "dev@agentre.dev",
  display_name: "Dev",
  avatar_url: "",
  github_login: "dev",
  csrf_token: "t",
};

const agentred = {
  id: 2,
  name: "Builder",
  kind: "agentred",
  platform: "linux",
  version: "1.0.0",
  fingerprint: "agentred-b",
  last_seen_at: 2,
  status: 1,
  online: true,
  is_this_device: false,
};

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/auth/me") return session;
    if (path.startsWith("/v1/agent-sessions?")) return { total: 0 };
    if (path === "/v1/devices") return { devices: [agentred] };
    if (path === "/v1/engine/providers") return { providers: [] };
    if (path === "/v1/engine/backends") return { backends: [] };
    if (path === "/v1/engine/cli-overlays") return { overlays: [] };
    throw new Error(`unexpected api call: ${path}`);
  });
});

describe("Settings", () => {
  it("contains only the LLM provider and Agent backend sections backed by shared panels", async () => {
    renderSettings();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    const providers = screen.getByRole("tab", { name: "LLM providers" });
    const backends = screen.getByRole("tab", { name: "Agent backends" });
    expect(providers.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Add First Provider")).toBeTruthy();

    fireEvent.click(backends);
    await waitFor(() =>
      expect(backends.getAttribute("aria-selected")).toBe("true"),
    );
    expect(await screen.findByText("Add First Backend")).toBeTruthy();

    expect(screen.queryByText(/Appearance/i)).toBeNull();
    expect(screen.queryByText(/Notifications/i)).toBeNull();
    expect(screen.queryByLabelText(/CLI path/i)).toBeNull();
  });

  // 透传环境变量表在控制台里编辑得动，与桌面端同一个编辑器（共享包的 EnvJsonField）。
  //
  // 它曾经被挡在外面：这张表不下发浏览器，读不到现有的键就不能整体保存——那会把用户
  // 自填的键连同密钥一起抹掉，而他还看不见。整表下发之后前提没了，同一份配置不该再
  // 因为入口不同而给出两种能力。
  //
  // builtin 是另一回事，仍然不给建：内置后端只跑在本机，控制台建出来的必然用不了。
  it("offers the same EnvJSON editor as the desktop in the console backend form", async () => {
    renderSettings();

    fireEvent.click(await screen.findByRole("tab", { name: "Agent backends" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Add First Backend" }),
    );
    const claudeCode = document.querySelector<HTMLButtonElement>(
      '[data-backend-type="claudecode"]',
    );
    expect(claudeCode).not.toBeNull();
    fireEvent.click(claudeCode!);

    expect(
      await screen.findByText("Advanced · Custom Environment Variables"),
    ).toBeTruthy();
    expect(document.querySelector('[data-backend-type="builtin"]')).toBeNull();
  });

  // CLI 路径配得了，Gateway token 仍然不给——两者此前一起被挡着，但它们不是一回事。
  //
  // 路径是**用户要填的配置**：不给这个框，网页上建的后端就只能靠 $PATH 撞运气，撞不上
  // 没有第二条路。它按 (后端, 绑定设备) 存成一条覆盖，服务端存得下，也读得回。
  //
  // token 不一样，它进的是那台机器的本机安全存储，服务端根本没有落点。摆出来只会让人
  // 白填一次、再打开发现是空的。
  it("offers a CLI path field but still no Gateway token field", async () => {
    renderSettings();

    fireEvent.click(await screen.findByRole("tab", { name: "Agent backends" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Add First Backend" }),
    );

    fireEvent.click(
      document.querySelector<HTMLButtonElement>(
        '[data-backend-type="claudecode"]',
      )!,
    );
    expect(await screen.findByText("CLI Path")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detect" })).toBeTruthy();

    fireEvent.click(
      document.querySelector<HTMLButtonElement>(
        '[data-backend-type="openclaw"]',
      )!,
    );
    expect(await screen.findByLabelText("Gateway WebSocket URL")).toBeTruthy();
    expect(screen.queryByLabelText("Gateway token")).toBeNull();
  });

  it("honestly explains that provider configuration can be saved before devices exist", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return session;
      if (path.startsWith("/v1/agent-sessions?")) return { total: 0 };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/engine/providers") return { providers: [] };
      throw new Error(`unexpected api call: ${path}`);
    });
    renderSettings();

    expect(
      await screen.findByText(
        "Configuration stays in your account and will sync after you register a device.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Account configuration · synced to 0 devices"),
    ).toBeTruthy();
    // 供应商与机器无关，这一页照常可用。
    expect(await screen.findByText("Add First Provider")).toBeTruthy();
  });

  it("sends the user to register a device instead of offering a backend nothing can run", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return session;
      if (path.startsWith("/v1/agent-sessions?")) return { total: 0 };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/backends") return { backends: [] };
      if (path === "/v1/engine/cli-overlays") return { overlays: [] };
      throw new Error(`unexpected api call: ${path}`);
    });
    renderSettings();

    fireEvent.click(await screen.findByRole("tab", { name: "Agent backends" }));

    expect(await screen.findByText("Register a device first")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to devices" }).getAttribute("href"),
    ).toBe("/devices");
    expect(screen.queryByText("Add First Backend")).toBeNull();
    expect(screen.queryByTestId("agent-backend-create")).toBeNull();
  });

  it("keeps the create entry once the account has a machine that can run a backend", async () => {
    renderSettings();

    fireEvent.click(await screen.findByRole("tab", { name: "Agent backends" }));

    expect(await screen.findByText("Add First Backend")).toBeTruthy();
    expect(screen.queryByText("Register a device first")).toBeNull();
  });

  it("shows the real no-online-agentred reason when a provider test cannot run", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return session;
      if (path.startsWith("/v1/agent-sessions?")) return { total: 0 };
      if (path === "/v1/devices") return { devices: [] };
      if (path === "/v1/engine/providers") {
        return {
          providers: [
            {
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
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });
    renderSettings();

    fireEvent.click(
      await screen.findByRole("button", { name: "Test Anthropic" }),
    );
    expect(
      await screen.findByText(
        /No online compute node is available\. Start or reconnect one of your devices and try again\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/connection succeeded/i)).toBeNull();
  });
});
