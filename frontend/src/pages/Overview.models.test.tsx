import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import Overview from "@/pages/Overview";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);

// 统计里记的是会话钉的模型 **key**（服务生成的引用键），不是人认得的模型 id。
const MODEL_KEY = "2660e973-8cac-44d3-a599-89095bb4004a";

function statsWithModels(models: unknown[]) {
  return {
    activity_stats_enabled: true,
    scope: "full",
    time_zone: "UTC",
    summary: {
      conversations: 5,
      conversations_total: 5,
      streak_days: 1,
      longest_streak_days: 1,
      active_days: 1,
      window_days: 30,
      devices_online: 1,
      devices_total: 1,
    },
    heatmap: { from: "2025-12-01", to: "2026-11-26", days: [] },
    agents: [],
    backends: [{ backend_type: "claudecode", count: 5 }],
    models,
    projects: [],
  };
}

function serve(models: unknown[], providers: unknown) {
  mockedApi.mockImplementation(async (path) => {
    const p = String(path);
    if (p.startsWith("/v1/stats/overview")) return statsWithModels(models);
    if (p === "/v1/engine/providers") {
      if (providers instanceof Error) throw providers;
      return { providers };
    }
    if (p === "/v1/devices") return { devices: [] };
    if (p === "/v1/auth/me") return { user_id: 1, display_name: "Dev" };
    if (p.startsWith("/v1/agent-sessions")) return { total: 0, items: [] };
    if (p === "/v1/workspace/agents") return { agents: [] };
    if (p === "/v1/workspace/projects") return { projects: [] };
    throw new Error("unexpected call: " + p);
  });
}

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={["/overview"]}>
      <Overview />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

const relay = {
  provider_key: "relay-anthropic",
  name: "relay-anthropic",
  type: "anthropic",
  default_model_key: "",
  enabled: true,
  models: [
    {
      model_key: MODEL_KEY,
      model_id: "claude-sonnet-5-5",
      name: "Sonnet",
      enabled: true,
    },
  ],
};

describe("overview: 后端与模型那张卡上的模型名", () => {
  beforeEach(async () => {
    mockedApi.mockReset();
    await i18n.changeLanguage("en");
  });

  it("Given 统计里是模型 key When 渲染 Then 那一行写的是模型 id，不是内部 key", async () => {
    serve(
      [{ provider_key: "relay-anthropic", model_key: MODEL_KEY, count: 1 }],
      [relay],
    );
    renderOverview();

    const card = await screen.findByTestId("card-backends");
    expect(await within(card).findByText("claude-sonnet-5-5")).toBeTruthy();
    expect(within(card).queryByText(MODEL_KEY)).toBeNull();
  });

  it("Given 目录里找不到这个 key（模型已删 / 目录取不到）When 渲染 Then 退回写 key，不写空", async () => {
    serve(
      [{ provider_key: "relay-anthropic", model_key: MODEL_KEY, count: 1 }],
      new Error("providers unavailable"),
    );
    renderOverview();

    const card = await screen.findByTestId("card-backends");
    expect(await within(card).findByText(MODEL_KEY)).toBeTruthy();
  });
});
