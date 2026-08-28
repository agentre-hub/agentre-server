import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  name: "mac-mini",
  kind: "agentred",
  platform: "darwin",
  version: "1.0.0",
  fingerprint: "fp-a",
  last_seen_at: 2,
  status: 1,
  online: true,
  is_this_device: false,
};

/**
 * 服务端的今天。夹具里它与那台机器的 reported_through 取同一个值 —— 判「已上报到今天」
 * 用的就是这两者相等，而不是浏览器自己的今天（跨时区差一天）。
 */
const SERVER_TODAY = "2026-08-28";

function settingsResponse(over: Record<string, unknown> = {}) {
  return {
    activity_stats_enabled: true,
    last_report_at: Date.now() - 12 * 60_000,
    saved_conversations: 128,
    today: SERVER_TODAY,
    devices: [
      {
        device_id: 2,
        name: "mac-mini",
        online: true,
        reported_through: SERVER_TODAY,
      },
      {
        device_id: 3,
        name: "MacBook-Pro",
        online: false,
        pending_backfill_days: 90,
      },
    ],
    ...over,
  };
}

/** 默认接线；用例只覆写自己关心的那一条。 */
function serve(overrides: Record<string, unknown> = {}) {
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const p = String(path);
    const key = `${(init?.method ?? "GET").toUpperCase()} ${p}`;
    for (const [match, value] of Object.entries(overrides)) {
      if (key === match || p === match) {
        if (typeof value === "function")
          return (value as (p: string, i?: RequestInit) => unknown)(p, init);
        return value;
      }
    }
    if (p === "/v1/stats/settings") return settingsResponse();
    if (p === "/v1/auth/me") return session;
    if (p.startsWith("/v1/agent-sessions")) return { total: 0 };
    if (p === "/v1/devices") return { devices: [agentred] };
    if (p === "/v1/engine/providers") return { providers: [] };
    if (p === "/v1/engine/backends") return { backends: [] };
    if (p === "/v1/engine/cli-overlays") return { overlays: [] };
    throw new Error(`unexpected api call: ${key}`);
  });
}

function renderSettings(route = "/settings") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** 打开隐私页签。 */
async function openPrivacy() {
  fireEvent.click(await screen.findByRole("tab", { name: "Privacy" }));
  return screen.findByTestId("privacy-activity-panel");
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
});

describe("设置 · 隐私", () => {
  it("是第三个页签，且只有打开它才去读统计设置", async () => {
    serve();
    renderSettings();

    await screen.findByRole("tab", { name: "LLM providers" });
    const privacy = screen.getByRole("tab", { name: "Privacy" });
    expect(privacy.getAttribute("aria-selected")).toBe("false");
    // 没打开就不读：别的两个页签不该为这一页多打一次后端。
    expect(
      mockedApi.mock.calls.some(([p]) => String(p) === "/v1/stats/settings"),
    ).toBe(false);

    await openPrivacy();
    expect(privacy.getAttribute("aria-selected")).toBe("true");
    await waitFor(() =>
      expect(
        mockedApi.mock.calls.filter(([p]) => String(p) === "/v1/stats/settings")
          .length,
      ).toBe(1),
    );
  });

  it("总览那两条链接直达这里：?tab=privacy 直接开在隐私上", async () => {
    serve();
    renderSettings("/settings?tab=privacy");

    expect(await screen.findByTestId("privacy-activity-panel")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Privacy" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("面板给出开关、逐台机器的上报状态和已保存的对话说明", async () => {
    serve();
    renderSettings("/settings?tab=privacy");

    const panel = await screen.findByTestId("privacy-activity-panel");
    expect(within(panel).getByText("Activity stats")).toBeTruthy();
    const toggle = within(panel).getByRole("switch", {
      name: "Activity stats",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    const rows = screen.getAllByTestId("privacy-device-row");
    expect(rows.length).toBe(2);
    expect(within(rows[0]).getByText("mac-mini")).toBeTruthy();
    expect(within(rows[0]).getByText("Reported through today")).toBeTruthy();
    expect(within(rows[1]).getByText("MacBook-Pro")).toBeTruthy();
    expect(
      within(rows[1]).getByText("Offline · 90 days of backfill left"),
    ).toBeTruthy();

    const saved = screen.getByTestId("privacy-saved-conversations");
    expect(within(saved).getByText("Saved conversations")).toBeTruthy();
    expect(within(saved).getByText("128 conversations")).toBeTruthy();
  });

  it("服务端没交出逐台进度时不画那一段，不摆一排「未知」", async () => {
    serve({ "/v1/stats/settings": settingsResponse({ devices: undefined }) });
    renderSettings("/settings?tab=privacy");

    await screen.findByTestId("privacy-activity-panel");
    expect(screen.queryAllByTestId("privacy-device-row").length).toBe(0);
  });

  it("已保存条数取不到就不画那一行数字，不编 0", async () => {
    serve({
      "/v1/stats/settings": settingsResponse({
        saved_conversations: undefined,
      }),
    });
    renderSettings("/settings?tab=privacy");

    const saved = await screen.findByTestId("privacy-saved-conversations");
    expect(within(saved).queryByTestId("privacy-saved-count")).toBeNull();
  });

  it("读失败就说读失败，不给一个猜出来的开关状态", async () => {
    serve({
      "/v1/stats/settings": () => {
        throw new Error("stats settings unavailable");
      },
    });
    renderSettings("/settings?tab=privacy");

    expect(
      await screen.findByText(
        "Could not load your stats settings. Please try again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("设置 · 隐私：开启", () => {
  it("开启前先摆出会 / 不会上报的对照与回填选择，默认勾上回填", async () => {
    serve({
      "/v1/stats/settings": settingsResponse({
        activity_stats_enabled: false,
        devices: undefined,
      }),
    });
    renderSettings("/settings?tab=privacy");

    const panel = await screen.findByTestId("privacy-activity-panel");
    fireEvent.click(
      within(panel).getByRole("switch", { name: "Activity stats" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("What is reported")).toBeTruthy();
    expect(within(dialog).getByText("What is never reported")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "The date, and how many conversations you started that day",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("File paths and cwd")).toBeTruthy();
    const backfill = within(dialog).getByRole("checkbox", {
      name: "Also backfill the history already on each machine",
    });
    expect(backfill.getAttribute("data-state")).toBe("checked");
    // 还没按「开启」之前不许有任何写请求飞出去。
    expect(
      mockedApi.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
  });

  it("确认后 PUT 出去的是 enabled + backfill，取消回填就带 false", async () => {
    const puts: unknown[] = [];
    serve({
      "PUT /v1/stats/settings": (_p: string, init?: RequestInit) => {
        puts.push(JSON.parse(String(init?.body)));
        return settingsResponse({ activity_stats_enabled: true });
      },
      "/v1/stats/settings": settingsResponse({
        activity_stats_enabled: false,
        devices: undefined,
      }),
    });
    renderSettings("/settings?tab=privacy");

    const panel = await screen.findByTestId("privacy-activity-panel");
    fireEvent.click(
      within(panel).getByRole("switch", { name: "Activity stats" }),
    );
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Also backfill the history already on each machine",
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));

    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({
      activity_stats_enabled: true,
      backfill: false,
    });
    // 写成功之后开关跟着服务端的回执走，不是本地乐观翻转。
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Activity stats" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    dialog = screen.queryByRole("dialog") as HTMLElement;
    expect(dialog).toBeNull();
  });

  it("写失败留在弹窗里说明，并且不翻转开关", async () => {
    serve({
      "PUT /v1/stats/settings": () => {
        throw new Error("write failed");
      },
      "/v1/stats/settings": settingsResponse({
        activity_stats_enabled: false,
        devices: undefined,
      }),
    });
    renderSettings("/settings?tab=privacy");

    const panel = await screen.findByTestId("privacy-activity-panel");
    fireEvent.click(
      within(panel).getByRole("switch", { name: "Activity stats" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));

    expect(
      await within(dialog).findByText("Could not save that. Please try again."),
    ).toBeTruthy();
    // 弹窗留在原地：写还没成功，关掉只会让人以为提交出去了。
    expect(screen.getByRole("dialog")).toBeTruthy();

    // 退出弹窗后开关仍在原位——状态跟服务端的回执走，不本地乐观翻转。
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen
        .getByRole("switch", { name: "Activity stats" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("设置 · 隐私：关闭并删除", () => {
  it("危险区那颗按钮先要一次确认，说清后果", async () => {
    serve();
    renderSettings("/settings?tab=privacy");

    await screen.findByTestId("privacy-activity-panel");
    const danger = screen.getByTestId("privacy-danger-zone");
    expect(within(danger).getByText("Turn off activity stats")).toBeTruthy();
    fireEvent.click(
      within(danger).getByRole("button", { name: "Turn off and delete" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Turn off activity stats?")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Your saved conversations themselves are not affected.",
      ),
    ).toBeTruthy();
  });

  it("确认之后 PUT 的 body 里没有 backfill：关闭没有回填这回事", async () => {
    const puts: unknown[] = [];
    serve({
      "PUT /v1/stats/settings": (_p: string, init?: RequestInit) => {
        puts.push(JSON.parse(String(init?.body)));
        return settingsResponse({
          activity_stats_enabled: false,
          devices: undefined,
        });
      },
    });
    renderSettings("/settings?tab=privacy");

    await screen.findByTestId("privacy-activity-panel");
    fireEvent.click(
      within(screen.getByTestId("privacy-danger-zone")).getByRole("button", {
        name: "Turn off and delete",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Turn off and delete" }),
    );

    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({ activity_stats_enabled: false });
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Activity stats" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });

  it("开关往关的方向拨走的是同一条危险确认，不是静默关掉", async () => {
    serve();
    renderSettings("/settings?tab=privacy");

    const panel = await screen.findByTestId("privacy-activity-panel");
    fireEvent.click(
      within(panel).getByRole("switch", { name: "Activity stats" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Turn off activity stats?")).toBeTruthy();
    expect(
      mockedApi.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
  });

  it("关闭之后危险区收起来：已经关了就没有可关的了", async () => {
    serve({
      "/v1/stats/settings": settingsResponse({
        activity_stats_enabled: false,
        devices: undefined,
      }),
    });
    renderSettings("/settings?tab=privacy");

    await screen.findByTestId("privacy-activity-panel");
    expect(screen.queryByTestId("privacy-danger-zone")).toBeNull();
  });
});
