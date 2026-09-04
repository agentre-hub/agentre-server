import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HEATMAP_MOBILE_WEEKS,
  heatmapColumnsFor,
} from "@/components/stats/Heatmap";
import * as accountChannel from "@/lib/accountChannel";
import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
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
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);

/** 把一条信号送进这个标签页共用的那条通道。 */
function deliver(signalType: string): void {
  const call = mockedStartChannel.mock.calls.at(-1);
  expect(call).toBeDefined();
  call![0].onRefresh(signalType);
}

/** 这一轮里 api() 被打了哪些路径。 */
function pathsCalled(): string[] {
  return mockedApi.mock.calls.map(([path]) => String(path));
}

const devices = [
  {
    id: 1,
    name: "Home NUC",
    kind: "agentred",
    fingerprint: "fp-1",
    online: true,
  },
  {
    id: 2,
    name: "Office Mac mini",
    kind: "agentred",
    fingerprint: "fp-2",
    online: false,
  },
];

const agents = [
  {
    sync_id: "ag-1",
    name: "Backend Agent",
    avatar_color: "#4f46e5",
    department_name: "Engineering",
    has_available_target: true,
    exec_targets: [
      {
        rank: 1,
        is_local_reference: false,
        device_id: 1,
        device_name: "Home NUC",
        backend_type: "claudecode",
        availability: "available",
        current: true,
      },
    ],
  },
  {
    sync_id: "ag-2",
    name: "QA Agent",
    avatar_color: "#0284c7",
    has_available_target: false,
    exec_targets: [
      {
        rank: 1,
        is_local_reference: false,
        backend_type: "codex",
        availability: "unpaired",
        current: false,
      },
    ],
  },
];

const projects = [
  { sync_id: "p1", name: "agentre-server" },
  { sync_id: "p2", name: "agentre" },
];

/** 一份可用的 GET /v1/stats/overview 响应，用例只覆盖自己关心的那几个键。 */
function statsResponse(over: Record<string, unknown> = {}) {
  return {
    activity_stats_enabled: true,
    scope: "full",
    time_zone: "Asia/Shanghai",
    summary: {
      conversations: 143,
      conversations_total: 486,
      streak_days: 9,
      longest_streak_days: 23,
      active_days: 18,
      window_days: 30,
      devices_online: 1,
      devices_total: 2,
    },
    heatmap: {
      from: "2025-09-01",
      to: "2026-08-28",
      days: [
        { day: "2026-08-28", count: 11 },
        { day: "2026-08-27", count: 4 },
      ],
      busiest_day: { day: "2026-05-14", count: 11 },
      avg_per_active_day: 5.4,
    },
    agents: [
      { sync_id: "ag-1", count: 42 },
      { sync_id: "ag-2", count: 31 },
    ],
    backends: [
      { backend_type: "claudecode", count: 90 },
      { backend_type: "codex", count: 44 },
      { backend_type: "", count: 9 },
    ],
    models: [
      { provider_key: "anthropic", model_key: "claude-sonnet-5", count: 60 },
      { provider_key: "", model_key: "", count: 18 },
    ],
    projects: [
      { sync_id: "p1", count: 46 },
      { sync_id: "", count: 23 },
    ],
    ...over,
  };
}

/** 一份「什么都还没发生」的响应：0 设备 0 对话。 */
function freshAccountResponse() {
  return statsResponse({
    activity_stats_enabled: false,
    scope: "saved",
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
  });
}

/** 默认接线：四条读取都成功，用例只覆写自己要变的那条。 */
function serve(overrides: Record<string, unknown> = {}) {
  mockedApi.mockImplementation(async (path) => {
    const p = String(path);
    for (const [prefix, value] of Object.entries(overrides)) {
      if (p === prefix || p.startsWith(prefix)) {
        if (typeof value === "function")
          return (value as (path: string) => unknown)(p);
        return value;
      }
    }
    if (p.startsWith("/v1/stats/overview")) return statsResponse();
    if (p === "/v1/devices") return { devices };
    // 外壳自己的两条读取（账号行、对话角标）；本页不管它们，但接住免得默认分支抛。
    if (p === "/v1/auth/me") return { user_id: 1, display_name: "Dev" };
    if (p.startsWith("/v1/agent-sessions")) return { total: 0, items: [] };
    if (p === "/v1/workspace/agents") return { agents };
    if (p === "/v1/workspace/projects") return { projects };
    throw new Error("unexpected call: " + p);
  });
}

function renderOverview() {
  return render(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

/** 把视口切到窄屏。AppShell / 热力卡都靠 useIsMobile 走另一套形态。 */
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const realMatchMedia = window.matchMedia;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedStartChannel.mockClear();
  localStorage.clear();
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

// ── 摘要四格（设计稿 r5xRl 摘要行） ──────────────────────────────────────
describe("overview: 摘要四格", () => {
  it("四格全部长在共享 Metric 上，数字来自 /v1/stats/overview", async () => {
    serve();
    renderOverview();

    expect(await screen.findByText("Conversations")).toBeTruthy();
    for (const id of [
      "tile-conversations",
      "tile-streak",
      "tile-active-days",
      "tile-online",
    ]) {
      const tile = screen.getByTestId(id);
      expect(tile.querySelector('[data-testid="metric-value"]')).toBeTruthy();
    }

    expect(
      within(screen.getByTestId("tile-conversations")).getByText("143"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-conversations")).getByText("486 total"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-streak")).getByText("9"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-streak")).getByText("Longest 23 days"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-active-days")).getByText("18"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-active-days")).getByText("/ 30 days"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("tile-active-days")).getByText("60% of days"),
    ).toBeTruthy();
  });

  it("设备在线是「现在」：值来自摘要，副行点名第一台离线的机器", async () => {
    serve();
    renderOverview();

    await screen.findByText("Devices online");
    const tile = screen.getByTestId("tile-online");
    expect(within(tile).getByText("1")).toBeTruthy();
    expect(within(tile).getByText("/ 2")).toBeTruthy();
    expect(within(tile).getByText("Office Mac mini is offline")).toBeTruthy();
  });

  it("四张卡里一个「—」都没有：这一版每一格都有真实数据源", async () => {
    serve();
    renderOverview();

    await screen.findByText("Conversations");
    for (const id of [
      "tile-conversations",
      "tile-streak",
      "tile-active-days",
      "tile-online",
    ]) {
      expect(screen.getByTestId(id).textContent).not.toContain("—");
    }
  });
});

// ── 顶栏：Fresh 指示与范围分段控件 ───────────────────────────────────────
describe("overview: 顶栏", () => {
  /*
    顶栏此前有一条绿点 + 「桌面端已连接」。它说的是**有没有机器在线**，而账号块上
    那颗痣说的是**这一屏还是不是实时的** —— 两件事，同一种绿点、同一族措辞，还会
    互相矛盾（通道断了，顶栏照说「已连接」）。实时性收成一个出口之后这条就撤了；
    在线机器数本来就有更好的落点：这一页的「Devices online」tile 与侧栏的 2/3。
  */
  it("顶栏不再有第二个连接说法", async () => {
    serve();
    renderOverview();
    expect(
      (await screen.findAllByText("Overview")).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Desktop connected")).toBeNull();
  });

  it("范围分段控件：默认近 30 天，切换后按新范围重取", async () => {
    const asked: string[] = [];
    serve({
      "/v1/stats/overview": (p: string) => {
        asked.push(
          new URLSearchParams(p.split("?")[1] ?? "").get("range") ?? "",
        );
        return statsResponse();
      },
    });
    renderOverview();

    await screen.findByText("Conversations");
    expect(asked).toEqual(["30d"]);
    const d30 = screen.getByRole("button", { name: "Last 30 days" });
    expect(d30.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    await waitFor(() => expect(asked).toContain("7d"));
    expect(
      screen
        .getByRole("button", { name: "Last 7 days" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    await waitFor(() => expect(asked).toContain("all"));
  });
});

// ── 活跃热力格子图 ───────────────────────────────────────────────────────
describe("overview: 活跃热力", () => {
  it("每列 7 格，当天那格上到最高档，to 之后的日子不画", async () => {
    serve();
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    const columns = screen.getAllByTestId("heat-week");
    // 列数由左列**实测的宽度**定（heatmapColumnsFor，账在 heatmap-grid.test.ts）。
    // jsdom 没有布局、clientWidth 恒为 0，所以这里落在「还没量到」的兜底那一档；
    // 真实宽度那条路由 heatmap-fit.test.tsx 覆盖。
    expect(columns.length).toBe(heatmapColumnsFor(0));
    // 每列 7 格，一格不少——少一格就是把某个星期几整行错开。
    for (const col of columns)
      expect(within(col).getAllByTestId("heat-cell").length).toBe(7);

    const busiest = document.querySelector('[data-day="2026-08-28"]');
    expect(busiest?.getAttribute("data-level")).toBe("4");
    // 那一周里 to 之后的日子不画：格位留着，但不给日期、也不上色。
    expect(document.querySelector('[data-day="2026-08-29"]')).toBeNull();
  });

  it("卡头右侧一条「统计设置 →」直达设置的隐私页签", async () => {
    serve();
    renderOverview();

    const link = await screen.findByRole("link", { name: "Stats settings →" });
    expect(link.getAttribute("href")).toBe("/settings?tab=privacy");
  });

  it("侧栏两条要点来自真实数据，没有就不画", async () => {
    serve();
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    expect(screen.getByText("Busiest day")).toBeTruthy();
    expect(screen.getByText("Average per active day")).toBeTruthy();
    // 带单位：稿子上是「11 条」「5.4 条」。一个光秃秃的 11 挨着「最活跃的一天」，
    // 读起来像是某个编号。
    const busiest = screen.getByTestId("heat-highlight-busiest");
    expect(within(busiest).getByText("11 conversations")).toBeTruthy();
    const avg = screen.getByTestId("heat-highlight-avg");
    expect(within(avg).getByText("5.4 conversations")).toBeTruthy();
  });

  it("没有最活跃的一天 / 平均值时那两条要点整条不画，不写 0", async () => {
    serve({
      "/v1/stats/overview": statsResponse({
        heatmap: { from: "2025-09-01", to: "2026-08-28", days: [] },
      }),
    });
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    expect(screen.queryByTestId("heat-highlight-busiest")).toBeNull();
    expect(screen.queryByTestId("heat-highlight-avg")).toBeNull();
  });

  it("图例给出五档色阶", async () => {
    serve();
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    const legend = screen.getByTestId("heat-legend");
    expect(within(legend).getAllByTestId("heat-legend-swatch").length).toBe(5);
    expect(within(legend).getByText("Less")).toBeTruthy();
    expect(within(legend).getByText("More")).toBeTruthy();
  });
});

// ── 三张分布 ─────────────────────────────────────────────────────────────
describe("overview: 分布卡", () => {
  it("Agent 使用排行按条数排，行上写出当前落到哪台机器", async () => {
    serve();
    renderOverview();

    await screen.findByText("Agent usage");
    const rows = screen.getAllByTestId("agent-rank-row");
    expect(rows.map((r) => r.getAttribute("data-sync-id"))).toEqual([
      "ag-1",
      "ag-2",
    ]);
    const first = rows[0];
    expect(within(first).getByText("Backend Agent")).toBeTruthy();
    expect(within(first).getByText("Engineering")).toBeTruthy();
    expect(within(first).getByText("42")).toBeTruthy();
    // 「当前落到哪台」是总览留下的那一条；逐档排序留在组织页。
    expect(within(first).getByText("Home NUC · Claude Code")).toBeTruthy();
  });

  it("没有可用执行目标的 Agent 不编一个落点出来", async () => {
    serve();
    renderOverview();

    await screen.findByText("Agent usage");
    const qa = screen
      .getAllByTestId("agent-rank-row")
      .find((r) => r.getAttribute("data-sync-id") === "ag-2")!;
    expect(within(qa).getByText("QA Agent")).toBeTruthy();
    expect(within(qa).queryByTestId("agent-rank-target")).toBeNull();
  });

  it("总览不再摆逐档排序控件（那一页在组织）", async () => {
    serve();
    renderOverview();

    await screen.findByText("Agent usage");
    expect(screen.queryByRole("button", { name: "Move up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move down" })).toBeNull();
  });

  it("后端与模型：空 backend_type 是「未上报」，provider+model 皆空是「跟随 Agent 绑定」", async () => {
    serve();
    renderOverview();

    const card = await screen.findByTestId("card-backends");
    expect(within(card).getByText("Claude Code")).toBeTruthy();
    expect(within(card).getByText("Codex")).toBeTruthy();
    expect(within(card).getByText("Not reported")).toBeTruthy();
    // 两个空是两件不同的事，不能并成一行。
    expect(within(card).getByText("claude-sonnet-5")).toBeTruthy();
    expect(within(card).getByText("Follows the agent binding")).toBeTruthy();
  });

  it("项目分布：空 sync_id 是「未归属项目」，名字来自项目树", async () => {
    serve();
    renderOverview();

    const card = await screen.findByTestId("card-projects");
    expect(within(card).getByText("agentre-server")).toBeTruthy();
    expect(within(card).getByText("No project")).toBeTruthy();
  });

  it("三张分布都没有数据时用共享 EmptyState，不编样本数字", async () => {
    serve({
      "/v1/stats/overview": statsResponse({
        agents: [],
        backends: [],
        models: [],
        projects: [],
      }),
    });
    renderOverview();

    await screen.findByTestId("empty-agents");
    for (const id of ["empty-agents", "empty-backends", "empty-projects"]) {
      const es = screen.getByTestId(id);
      expect(es.querySelector('[data-testid="empty-icon"]')).toBeTruthy();
      expect(es.textContent ?? "").not.toMatch(/\d{1,2}:\d{2}/);
      expect(es.textContent ?? "").not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    }
  });

  // R19：路径/CLIPath/EnvJSON 一个字都不能渲染出来，哪怕后端回归、把它们发了过来。
  it("即便响应里混进路径 / cli_path / env_json，页面上也一个字都不出现", async () => {
    serve({
      "/v1/workspace/agents": {
        agents: [
          {
            ...agents[0],
            exec_targets: [
              {
                ...agents[0].exec_targets[0],
                path: "/Users/wyz/secret-project",
                cli_path: "/usr/local/bin/claude",
                env_json: '{"OPENAI_API_KEY":"sk-super-secret"}',
              },
            ],
          },
        ],
      },
    });
    const { container } = renderOverview();
    await screen.findByText("Backend Agent");

    const text = container.textContent ?? "";
    expect(text).not.toContain("/Users/wyz");
    expect(text).not.toContain("/usr/local/bin/claude");
    expect(text).not.toContain("sk-super-secret");
    expect(text).not.toContain("cli_path");
    expect(text).not.toContain("env_json");
  });
});

// ── scope = saved：范围收窄，但热力图照常画 ───────────────────────────────
describe("overview: 只覆盖已保存的对话", () => {
  it("页顶一条说明覆盖全页，并给出开启完整活跃统计的去处", async () => {
    serve({
      "/v1/stats/overview": statsResponse({
        activity_stats_enabled: false,
        scope: "saved",
      }),
    });
    renderOverview();

    const notice = await screen.findByTestId("stats-scope-notice");
    expect(
      within(notice).getByText(
        "These stats only cover conversations you saved to your account, not all activity.",
      ),
    ).toBeTruthy();
    expect(
      within(notice)
        .getByRole("link", { name: "Turn on full activity stats →" })
        .getAttribute("href"),
    ).toBe("/settings?tab=privacy");
  });

  it("热力图照常画：已保存的那部分是真数据，只是更稀，不做成空态", async () => {
    serve({
      "/v1/stats/overview": statsResponse({
        activity_stats_enabled: false,
        scope: "saved",
      }),
    });
    renderOverview();

    await screen.findByTestId("stats-scope-notice");
    expect(screen.getByTestId("heatmap-grid")).toBeTruthy();
    expect(
      document
        .querySelector('[data-day="2026-08-28"]')
        ?.getAttribute("data-level"),
    ).toBe("4");
  });

  it("saved 态下热力卡头不再重复给一条「统计设置 →」", async () => {
    // 页顶那条说明条上已经有一条「开启完整活跃统计 →」指向同一处。一屏两条同去处的
    // 链接不是多一个入口，只是让人多读一遍、多犹豫一次点哪个。
    serve({
      "/v1/stats/overview": statsResponse({
        activity_stats_enabled: false,
        scope: "saved",
      }),
    });
    renderOverview();

    await screen.findByTestId("stats-scope-notice");
    expect(
      document.querySelectorAll('a[href="/settings?tab=privacy"]').length,
    ).toBe(1);
    expect(screen.queryByRole("link", { name: "Stats settings →" })).toBeNull();
  });

  it("scope=full 时热力卡头有那条「统计设置 →」", async () => {
    serve();
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    expect(
      screen
        .getByRole("link", { name: "Stats settings →" })
        .getAttribute("href"),
    ).toBe("/settings?tab=privacy");
  });

  it("写出日界按哪个时区切", async () => {
    // 日界是服务端机器的时区，不是浏览器的。不写出来的话，一个在另一个时区的用户
    // 只会觉得自己的「今天」错了一格，而没有任何地方解释得了那一格。
    serve({
      "/v1/stats/overview": statsResponse({ time_zone: "Asia/Shanghai" }),
    });
    renderOverview();

    const note = await screen.findByTestId("heatmap-timezone");
    expect(note.textContent).toContain("Asia/Shanghai");
  });

  it("scope=full 时没有那条说明", async () => {
    serve();
    renderOverview();
    await screen.findByText("Conversations");
    expect(screen.queryByTestId("stats-scope-notice")).toBeNull();
  });
});

// ── 三种非稳态（设计稿 l2U9p） ───────────────────────────────────────────
describe("overview: 非稳态", () => {
  it("加载中：热力网格先按空格子铺满整张网，摘要走骨架", async () => {
    let release: (v: unknown) => void = () => {};
    serve({
      "/v1/stats/overview": () => new Promise((r) => (release = r)),
    });
    renderOverview();

    // 网格不该在取到数那一刻凭空出现——取数前它就在那儿，只是没有颜色。
    const grid = await screen.findByTestId("heatmap-grid");
    const skeletonColumns = within(grid).getAllByTestId("heat-week").length;
    expect(skeletonColumns).toBeGreaterThan(0);
    expect(
      within(grid)
        .getAllByTestId("heat-cell")
        .every((c) => c.getAttribute("data-level") === "0"),
    ).toBe(true);
    expect(screen.getAllByTestId("tile-skeleton").length).toBe(4);
    // 骨架期间不摆一个编出来的数字。
    expect(screen.queryByTestId("tile-conversations")).toBeNull();

    release({ ...statsResponse(), code: 0 });

    // 落地之后仍是同样多的列：断言的是「不凭空撑开」这件事本身，而不是某个
    // 列数——列数已经跟着容器宽度走了。
    await screen.findByTestId("tile-conversations");
    expect(within(grid).getAllByTestId("heat-week").length).toBe(
      skeletonColumns,
    );
  });

  it("取数失败：整块统计区退成一句说明，并说清什么不受影响", async () => {
    serve({
      "/v1/stats/overview": () => {
        throw new Error("stats unavailable");
      },
    });
    renderOverview();

    expect(
      await screen.findByText("Could not load your stats. Please try again."),
    ).toBeTruthy();
    const state = screen.getByTestId("stats-error");
    expect(
      within(state).getByText("Stats are unavailable right now"),
    ).toBeTruthy();
    expect(
      within(state)
        .getByRole("link", { name: "Go to conversations →" })
        .getAttribute("href"),
    ).toBe("/chat");
    // 失败就是失败：不退回一张全是 0 的摘要。
    expect(screen.queryByTestId("tile-conversations")).toBeNull();
    expect(screen.queryByTestId("heatmap-grid")).toBeNull();
  });

  it("取数失败给一条重试的路，按下去真的重取", async () => {
    let calls = 0;
    serve({
      "/v1/stats/overview": () => {
        calls += 1;
        if (calls === 1) throw new Error("stats unavailable");
        return statsResponse();
      },
    });
    renderOverview();

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Conversations")).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("加载中这件事由容器上的 aria-busy 说，落地后当场撤掉", async () => {
    let release: (v: unknown) => void = () => {};
    serve({
      "/v1/stats/overview": () => new Promise((r) => (release = r)),
    });
    renderOverview();

    // 骨架自己是 aria-hidden 的（见 SessionListSkeleton 的成文约定），所以
    // 「正在取」只能由承载它的容器说；不说的话读屏用户整段加载期一片安静。
    const tiles = await screen.findByTestId("overview-tiles");
    expect(tiles.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("card-agents").getAttribute("aria-busy")).toBe(
      "true",
    );

    release({ ...statsResponse(), code: 0 });
    await screen.findByTestId("tile-conversations");
    expect(screen.getByTestId("overview-tiles").getAttribute("aria-busy")).toBe(
      null,
    );
    expect(screen.getByTestId("card-agents").getAttribute("aria-busy")).toBe(
      null,
    );
  });

  it("骨架条是会动的占位，不是静止的灰块", async () => {
    serve({ "/v1/stats/overview": () => new Promise(() => {}) });
    renderOverview();

    const bar = (await screen.findAllByTestId("tile-skeleton"))[0]
      .firstElementChild!;
    // 与既有三处骨架同色（bg-secondary）：bg-muted 压在 --background 上几乎不显影，
    // 静止的灰块读起来像内容坏了而不像占位。
    expect(bar.className).toContain("bg-secondary");
    expect(bar.className).toContain("animate-pulse");
    expect(bar.className).toContain("motion-reduce:animate-none");
  });

  it("切范围：新数字没回来之前，标签不许先跳到新范围", async () => {
    let release: (v: unknown) => void = () => {};
    let calls = 0;
    serve({
      "/v1/stats/overview": () => {
        calls += 1;
        if (calls === 1) return statsResponse();
        return new Promise((r) => (release = r));
      },
    });
    renderOverview();

    const tile = await screen.findByTestId("tile-conversations");
    expect(within(tile).getByText("Last 30 days")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    await waitFor(() => expect(calls).toBe(2));

    // 分段控件当场跟手（aria-pressed 已经在 7 天上），但格子里那个数还是 30 天的。
    // 标签跟着 range 走的话，这段窗口里界面在给一组贴错标签的数字——可读且错误，
    // 比闪一下骨架坏得多。
    expect(
      screen
        .getByRole("button", { name: "Last 7 days" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(screen.getByTestId("tile-conversations")).getByText(
        "Last 30 days",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("overview-tiles").getAttribute("aria-busy")).toBe(
      "true",
    );

    release({ ...statsResponse(), code: 0 });
    await waitFor(() =>
      expect(
        within(screen.getByTestId("tile-conversations")).getByText(
          "Last 7 days",
        ),
      ).toBeTruthy(),
    );
  });

  it("重试按下去要有反应：请求在路上时按钮停用", async () => {
    let calls = 0;
    serve({
      "/v1/stats/overview": () => {
        calls += 1;
        if (calls === 1) throw new Error("stats unavailable");
        return new Promise(() => {});
      },
    });
    renderOverview();

    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);

    // 第二次也失败的话界面上一个像素都不会变，用户只会连点。
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls).toBe(2);
  });

  it("全新账号：引导先登记一台设备，热力图全灰并说明这片灰是什么", async () => {
    serve({
      "/v1/stats/overview": freshAccountResponse(),
      "/v1/devices": { devices: [] },
      "/v1/workspace/agents": { agents: [] },
      "/v1/workspace/projects": { projects: [] },
    });
    renderOverview();

    const guide = await screen.findByTestId("stats-new-account");
    expect(
      within(guide).getByText(
        "Register a device first. Stats need your machines to start running conversations.",
      ),
    ).toBeTruthy();
    expect(
      within(guide)
        .getByRole("link", { name: "Go to devices" })
        .getAttribute("href"),
    ).toBe("/devices");

    // 网格照常铺满，但全是 heat-0，并且明写这不是坏了。
    const grid = screen.getByTestId("heatmap-grid");
    expect(
      within(grid)
        .getAllByTestId("heat-cell")
        .every((c) => c.getAttribute("data-level") === "0"),
    ).toBe(true);
    expect(
      screen.getByText(
        "This grey means there was no activity on that day — nothing is broken.",
      ),
    ).toBeTruthy();
  });

  it("账号有数据时不出现全新账号引导", async () => {
    serve();
    renderOverview();
    await screen.findByText("Conversations");
    expect(screen.queryByTestId("stats-new-account")).toBeNull();
  });
});

// ── 移动端（设计稿 SoTuq） ───────────────────────────────────────────────
describe("overview: 移动端", () => {
  // 周数按常量断言而不是抄一个字面量：那个数是按卡片宽度预算算出来的
  // （heatmap-grid.test.ts 守着那笔账），抄进来只会在它变了之后各说各的。
  it("热力图只出窄屏那一档的周数，并把更长的历史指向桌面端", async () => {
    setViewport(true);
    serve();
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    expect(screen.getAllByTestId("heat-week").length).toBe(
      HEATMAP_MOBILE_WEEKS,
    );
    expect(screen.getByText(`Last ${HEATMAP_MOBILE_WEEKS} weeks`)).toBeTruthy();
    expect(
      screen.getByText("A longer history is on the desktop app."),
    ).toBeTruthy();
  });

  /**
   * 顶栏在 390 宽的手机上放不下「标题 + 三档范围 + 头像 + 两颗图标按钮」：
   * 2026-08-31 量到范围控件（154–304）压在头像（258–286）和语言按钮（302–336）
   * 上，标题被截成「O...」。窄屏的顶栏只留标题与账号那一组，页面自己的控件下沉到
   * 内容第一行（与 Chat 的 ownHeader 同一条思路：移动端是另一棵树，不是压扁的
   * 桌面端）。
   */
  it("窄屏顶栏不摆页面自己的控件：范围分段下沉到内容里", async () => {
    setViewport(true);
    serve();
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    const rangeGroup = screen.getByRole("group", { name: "Stats range" });
    expect(screen.getByRole("banner").contains(rangeGroup)).toBe(false);
    expect(screen.getByRole("main").contains(rangeGroup)).toBe(true);
  });

  it("宽屏照旧摆在顶栏里", async () => {
    setViewport(false);
    serve();
    renderOverview();

    await screen.findByTestId("heatmap-grid");
    const rangeGroup = screen.getByRole("group", { name: "Stats range" });
    expect(screen.getByRole("banner").contains(rangeGroup)).toBe(true);
  });

  it("窄屏不做横向滚动：热力卡身上没有 overflow-x-auto", async () => {
    setViewport(true);
    serve();
    renderOverview();

    const grid = await screen.findByTestId("heatmap-grid");
    expect(grid.className).not.toContain("overflow-x-auto");
    expect(grid.className).not.toContain("overflow-x-scroll");
  });

  it("桌面/移动重排：统计 2 列→4 列，分布行纵向→横向，右列满宽→300px", async () => {
    serve();
    renderOverview();
    await screen.findByText("Conversations");

    const tiles = screen.getByTestId("overview-tiles");
    expect(tiles.className).toContain("grid-cols-2");
    expect(tiles.className).toContain("md:grid-cols-4");
    const cols = screen.getByTestId("overview-cols");
    expect(cols.className).toContain("flex-col");
    expect(cols.className).toContain("lg:flex-row");
    const aside = screen.getByTestId("overview-aside");
    expect(aside.className).toContain("w-full");
    expect(aside.className).toContain("lg:w-[300px]");
  });
});

// ── 跟着账号通道走 ───────────────────────────────────────────────────────
describe("overview: 跟着通道走", () => {
  it("三类信号各自只重取对应的那一份", async () => {
    serve();
    renderOverview();
    await waitFor(() => expect(pathsCalled()).toContain("/v1/devices"));
    mockedApi.mockClear();

    // 外壳的侧栏 Meta 与本页的设备统计各取各的，这份重复在挂载时本来就有。
    deliver(accountChannel.AccountChannelDevicePresence);
    await waitFor(() => expect(pathsCalled().length).toBeGreaterThan(0));
    expect(new Set(pathsCalled())).toEqual(new Set(["/v1/devices"]));
    mockedApi.mockClear();

    deliver(accountChannel.AccountChannelSyncVersion);
    await waitFor(() =>
      expect(new Set(pathsCalled())).toEqual(
        new Set(["/v1/workspace/agents", "/v1/workspace/projects"]),
      ),
    );
    mockedApi.mockClear();

    // 一条对话存进账号 = 统计变了，重取的是统计，不是 Agent 名单。外壳侧栏那颗
    // 「需要你」角标订的是同一类信号，所以这一发有两个订阅者应答——与上面设备
    // 那一段同理，各取各的那一份。
    deliver(accountChannel.AccountChannelMirrorChanged);
    await waitFor(() => expect(pathsCalled().length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(new Set(pathsCalled().map((p) => p.split("?")[0]))).toEqual(
        new Set(["/v1/stats/overview", "/v1/agent-sessions/attention-count"]),
      ),
    );
  });

  it("设备上线之后这一页当场跟着变，不用刷新整页", async () => {
    // 观察点是在线 tile 上那句「谁离线了」：它读的是 /v1/devices 那一份名单，
    // 与撤掉的顶栏指示同一个数据源，所以订阅还活着这件事照样验得出来。
    serve({ "/v1/devices": { devices: [{ ...devices[0], online: false }] } });
    renderOverview();
    expect(await screen.findByText("Home NUC is offline")).toBeTruthy();

    serve({ "/v1/devices": { devices: [devices[0]] } });
    deliver(accountChannel.AccountChannelDevicePresence);

    await waitFor(() =>
      expect(screen.queryByText("Home NUC is offline")).toBeNull(),
    );
  });
});
