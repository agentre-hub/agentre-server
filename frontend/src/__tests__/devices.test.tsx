import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as accountChannel from "@/lib/accountChannel";
import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import Devices from "@/pages/Devices";
import { deviceKindIcon } from "@/lib/deviceKind";
import { Laptop, Server } from "lucide-react";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// 副行 cardSummary 的「对话在跑」数要真去问那台 agentred（与 DeviceSessionCounts
// 同一真相源）：3 条会话里 2 条 running。
//
// 每个 target 只造一份并缓存住：真 useRelayMachine 交出的 client 在同一个目标上是
// **稳定**的，而 useSessionCounts 把它写进 effect 依赖。每次渲染新造一个对象会让
// 「取计数 → setState → 重渲染 → 又取一次」永远转下去，假时钟下这会把整条微任务
// 队列占死。
vi.mock("@/hooks/use-relay", () => {
  const sessions = [
    {
      conversationId: "c-1",
      lifecycleState: "running",
      latestSeq: 1,
      waitingForInput: true,
    },
    { conversationId: "c-2", lifecycleState: "idle", latestSeq: 1 },
    { conversationId: "c-3", lifecycleState: "running", latestSeq: 1 },
  ];
  const perTarget = new Map<string, unknown>();
  return {
    useRelayMachine: (target: string | null) => {
      const key = target ?? "";
      if (!perTarget.has(key)) {
        perTarget.set(key, {
          client: target ? { request: async () => ({ sessions }) } : null,
          relayState: target ? "connected" : "disconnected",
          relayTicket: null,
          relayTicketError: null,
        });
      }
      return perTarget.get(key);
    },
  };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);
const mockedStartChannel = vi.mocked(accountChannel.startAccountChannel);

function renderDevices() {
  return render(
    <MemoryRouter>
      <Devices />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

const listResponse = {
  devices: [
    {
      id: 1,
      name: "nuc-01",
      kind: "agentred",
      platform: "linux",
      version: "0.4.0",
      fingerprint: "fp-1",
      last_seen_at: 1754000000000,
      status: 1,
      online: true,
      is_this_device: false,
    },
    {
      id: 2,
      name: "laptop",
      kind: "desktop",
      platform: "darwin",
      version: "0.3.0",
      fingerprint: "fp-2",
      last_seen_at: 1753990000000,
      status: 1,
      online: false,
      is_this_device: true,
    },
  ],
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedStartChannel.mockClear();
});

describe("device page design alignment", () => {
  it("TopBar 注入设备总数 Cnt；有在线 agentred 时显示 Fresh『桌面端已连接』", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    // Cnt = 设备总数（font-mono，text-muted-foreground）
    const cnt = screen.getByTestId("devices-count");
    expect(cnt.textContent).toBe("2");
    // 裸数字必须带 aria-label（设计文档：Cnt 一律 aria-label'd，SR 不能只听到「2」）。
    expect(cnt.getAttribute("aria-label")).toBe("2 devices");
    // Fresh：agentred 在线 → 桌面端已连接
    expect(screen.getByText("Desktop connected")).toBeTruthy();
  });

  it("没有在线 agentred 时不渲染 Fresh（诚实不编状态）", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 2,
              name: "laptop",
              kind: "desktop",
              platform: "darwin",
              version: "0.3.0",
              fingerprint: "fp-2",
              last_seen_at: 1753990000000,
              status: 1,
              online: false,
              is_this_device: true,
            },
          ],
        };
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("laptop");

    expect(screen.getByTestId("devices-count").textContent).toBe("1");
    expect(screen.queryByText("Desktop connected")).toBeNull();
  });

  // 规格「设备」节：不渲染右侧常驻撤销说明卡；真实撤销进入每台可撤销设备的
  // 行级更多菜单，随后出现确认对话框。
  it("常驻『撤销这台设备』旁白卡不存在，撤销只出现在行级更多菜单", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    // 危险卡标题/正文都不该出现（revokeCardTitle='Revoke this device' 无问号；
    // 对话框标题现在是点名的 'Revoke nuc-01?'，此刻未打开）。
    expect(screen.queryByText("Revoke this device")).toBeNull();
    expect(screen.queryByText(/can no longer refresh/i)).toBeNull();

    // 撤销入口在每台可撤销设备的行级菜单里
    const nuc = screen
      .getByText("nuc-01")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.pointerDown(
      within(nuc).getByRole("button", { name: /^Actions for / }),
      { button: 0, ctrlKey: false },
    );
    // 菜单走 Portal 挂在 body 上（共享包的 DropdownMenu），不在这张卡里面找。
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Revoke" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Revoke nuc-01?")).toBeTruthy();
  });

  it("设备卡结构：状态标记 + 设备图标 + 名 + 类型 chip；Meta 在副行", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    const nuc = screen
      .getByText("nuc-01")
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(nuc).getByText(/Compute node/)).toBeTruthy(); // 类型 chip
    expect(within(nuc).getByText(/Online/)).toBeTruthy(); // 状态标记（StatusMark）
    expect(within(nuc).getByTestId("device-icon-1")).toBeTruthy(); // 设备图标
    expect(within(nuc).getByText(/linux/)).toBeTruthy(); // Meta platform
    expect(within(nuc).getByText(/0\.4\.0/)).toBeTruthy(); // Meta version
  });

  it("已撤销设备（status≠ACTIVE）不渲染任何撤销动作", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices")
        return {
          devices: [
            {
              id: 9,
              name: "old-box",
              kind: "desktop",
              platform: "darwin",
              version: "0.2.0",
              fingerprint: "fp-old",
              last_seen_at: 1753000000000,
              status: 2, // 已撤销
              online: false,
              is_this_device: false,
            },
          ],
        };
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    const row = (await screen.findByText("old-box")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;

    // 已撤销行没有行级更多菜单：没有「撤销」这种动作可做
    expect(
      within(row).queryByRole("button", { name: "Row actions" }),
    ).toBeNull();
  });

  it("副行 cardSummary 有数据才显示：展开在线 agentred 后出现『项目 · 对话在跑』", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=1") {
        return {
          device_id: 1,
          kind: "agentred",
          runnable_agents: [],
          projects: [
            { sync_id: "proj-1", name: "agentre-server", configured: true },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    const nuc = screen
      .getByText("nuc-01")
      .closest('[data-slot="card"]') as HTMLElement;
    // 未展开：项目数/对话数都还没拿到 → 副行诚实省略
    expect(within(nuc).queryByText(/conversations running/i)).toBeNull();

    fireEvent.click(within(nuc).getByRole("button", { name: /show details/i }));
    // 展开后：1 个项目 · 2 个对话在跑（relay 3 会话中 2 条 running）
    await within(nuc).findByText("1 projects · 2 conversations running");
  });

  it("desktop 展开后有项目但拿不到对话数 → 副行仍省略（不编数字）", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=2") {
        return {
          device_id: 2,
          kind: "desktop",
          projects: [
            { sync_id: "proj-1", name: "agentre-server", configured: true },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("laptop");

    const laptop = screen
      .getByText("laptop")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(
      within(laptop).getByRole("button", { name: /show details/i }),
    );
    await within(laptop).findByText("agentre-server");

    expect(within(laptop).queryByText(/conversations running/i)).toBeNull();
  });

  it("展开区两节：项目（含未配置路径小字）+ 能跑的 Agent（名 + 档位）", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=1") {
        return {
          device_id: 1,
          kind: "agentred",
          runnable_agents: [
            { sync_id: "agent-1", name: "Frontend Agent", rank: 2 },
          ],
          projects: [
            { sync_id: "proj-1", name: "agentre-server", configured: true },
            { sync_id: "proj-2", name: "agentre-hub", configured: false },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    const nuc = screen
      .getByText("nuc-01")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(within(nuc).getByRole("button", { name: /show details/i }));

    // 项目节
    expect(await within(nuc).findByText("Projects")).toBeTruthy();
    expect(within(nuc).getByText("agentre-server")).toBeTruthy();
    expect(within(nuc).getByText("agentre-hub")).toBeTruthy();
    expect(within(nuc).getByText("Not configured")).toBeTruthy();
    // 能跑的 Agent 节
    expect(within(nuc).getByText("Agents that can run here")).toBeTruthy();
    expect(within(nuc).getByText("Frontend Agent")).toBeTruthy();
    expect(within(nuc).getByText("Rank 2")).toBeTruthy();
  });

  it("移动端行式信息顺序：图标方框 + 名 + 类型 + 状态 + Meta，且无接单开关/负载条", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      renderDevices();
      await screen.findByText("nuc-01");

      const row = screen
        .getByText("nuc-01")
        .closest('[data-slot="card"]') as HTMLElement;
      // 信息顺序：设备图标方框 + 名 + 类型 chip + 状态 + Meta
      expect(within(row).getByTestId("device-icon-1")).toBeTruthy();
      expect(within(row).getByText(/Compute node/)).toBeTruthy();
      expect(within(row).getByText(/Online/)).toBeTruthy();
      expect(within(row).getByText(/linux/)).toBeTruthy();
      expect(within(row).getByText(/0\.4\.0/)).toBeTruthy();

      // 无真实能力的控件不渲染：接单开关、并发负载条
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByText(/concurrent/i)).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("deviceKindIcon 把每种 kind 映射到稳定 lucide 图标", () => {
    expect(deviceKindIcon("agentred")).toBe(Server);
    expect(deviceKindIcon("desktop")).toBe(Laptop);
  });
});

// 规格「web 控制台：设备页 · 入口与展开条件」：整页只有一个「添加设备」入口，
// 点它就地在列表上方展开三步引导；空态默认展开并取代那句孤立的空句；
// 列表加载失败时只留既有错误 —— 不展开引导，也不改口说没有设备。
describe("设备页的非稳态", () => {
  it("列表首屏摆骨架并由容器说自己在取，而不是一行不占位的字", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return new Promise(() => {});
      throw new Error("unexpected call: " + path);
    });
    renderDevices();

    // 加载期间此前只有一行字：动作行、引导、计数角标全不渲染，数据落地时一次性
    // 把内容顶下去。骨架占的正是最终布局的位置。
    const holder = await screen.findByTestId("device-list-loading");
    expect(holder.getAttribute("aria-busy")).toBe("true");
    expect(
      within(holder)
        .getByTestId("device-list-skeleton")
        .getAttribute("aria-hidden"),
    ).toBe("true");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("展开详情读失败时给一条重试的路，不必收起再展开", async () => {
    let calls = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=1") {
        calls += 1;
        if (calls === 1) throw new TypeError("network down");
        return {
          device_id: 1,
          kind: "agentred",
          runnable_agents: [],
          projects: [],
        };
      }
      throw new Error("unexpected call: " + path);
    });
    renderDevices();

    const card = (await screen.findByText("nuc-01")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    fireEvent.click(within(card).getByTestId("device-expand-1"));
    await within(card).findByText(/could not load this device's details/i);

    // 「收起再展开」确实会重试（device-expand 那条用例守着），但界面上一个字都没
    // 提过这条出路，用户只会去刷新整页。
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await within(card).findByText("No agents can run on this device yet.");
    expect(calls).toBe(2);
  });
});

describe("add-device entry and guide expansion", () => {
  it("有设备时：列表上方只有一个『添加设备』入口，引导不渲染", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    expect(screen.getAllByRole("button", { name: "Add device" })).toHaveLength(
      1,
    );
    expect(screen.queryByTestId("add-device-guide")).toBeNull();
  });

  it("点入口：引导展开在列表上方、入口消失；收起后回到原样", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    fireEvent.click(screen.getByRole("button", { name: "Add device" }));

    const guide = screen.getByTestId("add-device-guide");
    const firstRow = screen.getByTestId("device-row-1");
    // 「在列表上方」：引导在文档顺序里排在第一台设备之前
    expect(
      guide.compareDocumentPosition(firstRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 展开时入口不再渲染（全页仍然只有一个添加入口）
    expect(screen.queryByRole("button", { name: "Add device" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse guide" }));
    expect(screen.queryByTestId("add-device-guide")).toBeNull();
    expect(screen.getByRole("button", { name: "Add device" })).toBeTruthy();
  });

  it("空态：引导默认展开取代孤立空句，且不提供收起", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [] };
      throw new Error("unexpected call: " + path);
    });

    renderDevices();

    expect(await screen.findByTestId("add-device-guide")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse guide" })).toBeNull();
    // 引导已经展开，重复的入口不再渲染
    expect(screen.queryByRole("button", { name: "Add device" })).toBeNull();
  });

  it("加载失败：只显示既有错误，不展开引导、也不说没有设备", async () => {
    mockedApi.mockImplementation(async () => {
      throw new SyntaxError("Unexpected token '<' ... is not valid JSON");
    });

    renderDevices();

    expect(
      await screen.findByText("Could not load your devices. Please try again."),
    ).toBeTruthy();
    expect(screen.queryByTestId("add-device-guide")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add device" })).toBeNull();
    // 「没有设备」如今有两个说法：展开的引导，和顶栏那个数字。取不到列表时
    // 两个都不许出现——写着 0 的计数和那句被删掉的空句是同一句谎话。
    expect(screen.queryByTestId("devices-count")).toBeNull();
  });
});

describe("设备页跟着通道走", () => {
  // 设备列表此前只在挂载时取一次：一台机器上线要整页刷新或者切走再切回来才看得到。
  // 只订在线态那一类信号 —— 组织架构改了、别人发了条消息，都不该让这一页重取。
  it("设备上线的信号一到就重取整张列表", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });
    renderDevices();
    await screen.findByText("nuc-01");

    // 外壳（侧栏的在线/全部）与本页同时在场，但共用同一条通道：server 那边一条
    // 连接就是一份 Redis 订阅，各开各的等于把订阅数乘上页面数。
    expect(mockedStartChannel).toHaveBeenCalledTimes(1);

    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") {
        return {
          devices: [
            ...listResponse.devices,
            {
              ...listResponse.devices[0],
              id: 3,
              name: "nuc-02",
              fingerprint: "fp-3",
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });
    mockedStartChannel.mock.calls[0][0].onRefresh(
      accountChannel.AccountChannelDevicePresence,
    );

    expect(await screen.findByText("nuc-02")).toBeTruthy();
  });
});

// ── 版本可见与升级出口（规格 2026-09-03「控制台呈现与 latest 来源」）─────────

const AGENTRED_UPGRADABLE = {
  id: 1,
  name: "build-box-02",
  kind: "agentred",
  platform: "linux/amd64",
  version: "0.5.2",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
  is_this_device: false,
  protocol_mismatch: false,
  daemon_commit: "a1b2c3d",
  daemon_build_known: true,
};

/** daemon 那句拒绝的原文（cmd/agentred 与桌面端说的是同一句 —— 决策 22）。 */
const DAEMON_ACTIVE_TURNS_WORDING =
  "this machine has 2 running conversation(s); upgrading would interrupt them";

type UpgradeReply = {
  accepted: boolean;
  reject_reason?: string;
  message?: string;
  active_turns?: number;
  target_version?: string;
};

/** 本轮四条真实端点的桩：设备清单（可变）、latest、设备详情、一键升级。 */
function mockConsole(opts: {
  devices: () => unknown[];
  latest?: { known: boolean; version?: string };
  upgrade?: (body: { device_id: number; force?: boolean }) => UpgradeReply;
  upgradeCalls?: { device_id: number; force?: boolean }[];
}) {
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/devices") return { devices: opts.devices() };
    if (path === "/v1/release/latest") return opts.latest ?? { known: false };
    if (path.startsWith("/v1/workspace/device-detail"))
      return {
        device_id: 1,
        kind: "agentred",
        runnable_agents: [],
        projects: [],
      };
    if (path === "/v1/devices/upgrade") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      opts.upgradeCalls?.push(body);
      return opts.upgrade ? opts.upgrade(body) : { accepted: true };
    }
    throw new Error("unexpected call: " + path);
  });
}

async function expandRow(id: number) {
  fireEvent.click(screen.getByTestId(`device-expand-${id}`));
  await screen.findByTestId(`device-upgrade-${id}`);
}

describe("设备卡的版本与升级出口", () => {
  it("卡上的版本就是那台 agentred 此刻自报的版本：列表重取后跟着变", async () => {
    let version = "0.5.2";
    mockConsole({ devices: () => [{ ...AGENTRED_UPGRADABLE, version }] });
    renderDevices();
    await screen.findByText("build-box-02");
    expect(screen.getByTestId("device-meta").textContent).toContain("0.5.2");

    // 握手写回把 devices.version 刷新了（T8）：下一次列表重取，卡上就是新版本。
    version = "0.6.0";
    mockedStartChannel.mock.calls[0][0].onRefresh(
      accountChannel.AccountChannelDevicePresence,
    );
    await screen.findByText(/0\.6\.0/);
    expect(screen.getByTestId("device-meta").textContent).toContain("0.6.0");
  });

  it("最新版已知且更新：副行出一枚弱徽标", async () => {
    mockConsole({
      devices: () => [AGENTRED_UPGRADABLE],
      latest: { known: true, version: "0.6.0" },
    });
    renderDevices();
    await screen.findByText("build-box-02");

    expect(
      (await screen.findByTestId("device-version-badge-1")).textContent,
    ).toContain("Upgradable to 0.6.0");
  });

  it("已是最新：不出徽标，展开区说「已是最新」并注明版本", async () => {
    mockConsole({
      devices: () => [{ ...AGENTRED_UPGRADABLE, version: "0.6.0" }],
      latest: { known: true, version: "0.6.0" },
    });
    renderDevices();
    await screen.findByText("build-box-02");
    await expandRow(1);

    expect(screen.queryByTestId("device-version-badge-1")).toBeNull();
    const action = screen.getByTestId("device-upgrade-action-1");
    expect(action.textContent).toContain("Up to date (0.6.0)");
    expect((action as HTMLButtonElement).disabled).toBe(true);
  });

  it("拿不到最新版：同样不出徽标，但展开区两句都不说 —— 与「已是最新」分得开", async () => {
    mockConsole({
      devices: () => [AGENTRED_UPGRADABLE],
      latest: { known: false },
    });
    renderDevices();
    await screen.findByText("build-box-02");
    await expandRow(1);

    expect(screen.queryByTestId("device-version-badge-1")).toBeNull();
    // 不冒充「已是最新」，也不编一个「有新版本」。
    expect(screen.queryByText(/Up to date/)).toBeNull();
    expect(screen.queryByText(/New version/)).toBeNull();
    // 出口仍在：一键升级与命令卡始终并列（决策 18）。
    const action = screen.getByTestId("device-upgrade-action-1");
    expect((action as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen.getByTestId("device-upgrade-command-1").textContent,
    ).toContain("agentred update");
  });

  // 决策 5：「可升级」判定只在短 commit 非空（发布构建）时做；commit 为空的机器显示
  // 为开发构建，永不劝升。它的依据正是这条用例的取值：未注入版本的构建自称 1.0.0，
  // 比任何 0.x 正式版都「新」——不加这道闸，这台机器会被判成「已是最新」。
  it("开发构建：如实说是开发构建，不出徽标、不劝升，也不冒充「已是最新」", async () => {
    mockConsole({
      devices: () => [
        {
          ...AGENTRED_UPGRADABLE,
          version: "1.0.0",
          daemon_commit: "",
          daemon_build_known: true,
        },
      ],
      latest: { known: true, version: "0.6.0" },
    });
    renderDevices();
    await screen.findByText("build-box-02");

    expect(screen.queryByTestId("device-version-badge-1")).toBeNull();
    expect(screen.getByTestId("device-meta").textContent).toContain(
      "Development build",
    );
    await expandRow(1);
    expect(screen.queryByText(/Up to date/)).toBeNull();
    expect(
      (screen.getByTestId("device-upgrade-action-1") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // 出口仍在：命令卡与一键升级始终并列（决策 18）。
    expect(
      screen.getByTestId("device-upgrade-command-1").textContent,
    ).toContain("agentred update");
  });

  // 「知不知道这台机器的构建」与「commit 是空串」是两件事（决策 19：拿不到就是拿不到）。
  // 从没跟这台机器握过手时，server 说不出它是不是发布构建 —— 此时不能借「commit 为空」
  // 把它说成开发构建，也不能拿一个不可比的版本号判它「已是最新」。
  it("server 还不知道这台机器的构建：既不说开发构建，也不下版本判断", async () => {
    mockConsole({
      devices: () => [
        {
          ...AGENTRED_UPGRADABLE,
          version: "1.0.0",
          daemon_commit: "",
          daemon_build_known: false,
        },
      ],
      latest: { known: true, version: "0.6.0" },
    });
    renderDevices();
    await screen.findByText("build-box-02");

    expect(screen.queryByTestId("device-version-badge-1")).toBeNull();
    expect(screen.getByTestId("device-meta").textContent).toContain("1.0.0");
    expect(screen.queryByText("Development build")).toBeNull();
    await expandRow(1);
    expect(screen.queryByText(/Up to date/)).toBeNull();
  });

  it("协议不匹配：强提示 + 可复制的命令卡，一键升级够不着就不画", async () => {
    mockConsole({
      devices: () => [
        { ...AGENTRED_UPGRADABLE, version: "0.4.1", protocol_mismatch: true },
      ],
      latest: { known: true, version: "0.6.0" },
    });
    renderDevices();
    await screen.findByText("build-box-02");

    expect(screen.getByTestId("device-version-badge-1").textContent).toContain(
      "Too old",
    );
    await expandRow(1);
    expect(screen.getByText("Too old to connect")).toBeTruthy();
    expect(
      screen.getByTestId("device-upgrade-command-1").textContent,
    ).toContain("agentred update");
    // 握手都没过，一键升级必然够不着：出口只有命令卡。
    expect(screen.queryByTestId("device-upgrade-action-1")).toBeNull();
  });
});

describe("一键升级走完整条路", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /**
   * 假时钟下不用 findBy*：testing-library 的 waitFor 自己要跑真定时器，与被冻住的
   * 时钟互相等。这里改成「推一格时钟 + 同步查询」，等待关系因此完全显式。
   */
  async function renderAndExpand() {
    renderDevices();
    await advance(0);
    fireEvent.click(screen.getByTestId("device-expand-1"));
    await advance(0);
    expect(screen.getByTestId("device-upgrade-1")).toBeTruthy();
  }

  it("升级中 → 成功：重连后读到的版本变了就是成功", async () => {
    let version = "0.5.2";
    mockConsole({
      devices: () => [{ ...AGENTRED_UPGRADABLE, version }],
      latest: { known: true, version: "0.6.0" },
      upgrade: () => ({ accepted: true, target_version: "0.6.0" }),
    });
    await renderAndExpand();

    fireEvent.click(screen.getByTestId("device-upgrade-action-1"));
    await advance(0);
    expect(screen.getByText("Upgrading to 0.6.0")).toBeTruthy();

    // 它重启回来了，自报的版本变了。
    version = "0.6.0";
    await advance(5_000);
    expect(screen.getByText("Upgrade complete")).toBeTruthy();
  });

  it("升级中 → 5 分钟没回来：超时失败，出口回到命令卡", async () => {
    mockConsole({
      devices: () => [AGENTRED_UPGRADABLE],
      latest: { known: true, version: "0.6.0" },
      upgrade: () => ({ accepted: true, target_version: "0.6.0" }),
    });
    await renderAndExpand();

    fireEvent.click(screen.getByTestId("device-upgrade-action-1"));
    await advance(0);
    expect(screen.getByText("Upgrading to 0.6.0")).toBeTruthy();

    // 4 分 59 秒还在等 —— 不提前判死。
    await advance(4 * 60_000 + 59_000);
    expect(screen.queryByText("It didn't come back")).toBeNull();

    await advance(2_000);
    expect(screen.getByText("It didn't come back")).toBeTruthy();
    expect(
      screen.getByTestId("device-upgrade-command-1").textContent,
    ).toContain("agentred update");
  });

  it("有对话在跑：主动作不禁用、改口「仍要升级」，force 只在二次确认之后才出去", async () => {
    const upgradeCalls: { device_id: number; force?: boolean }[] = [];
    mockConsole({
      devices: () => [AGENTRED_UPGRADABLE],
      latest: { known: true, version: "0.6.0" },
      upgradeCalls,
      upgrade: (body) =>
        body.force
          ? { accepted: true, target_version: "0.6.0" }
          : {
              accepted: false,
              reject_reason: "active_turns",
              message: DAEMON_ACTIVE_TURNS_WORDING,
              active_turns: 2,
            },
    });
    await renderAndExpand();

    fireEvent.click(screen.getByTestId("device-upgrade-action-1"));
    await advance(0);
    expect(upgradeCalls).toEqual([{ device_id: 1, force: false }]);

    // 不禁用：禁用了这台整天有对话在跑的机器就彻底没有出口（决策 21）。
    const action = screen.getByTestId(
      "device-upgrade-action-1",
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.textContent).toContain("Upgrade anyway");
    // daemon 那句话原样呈现，不重翻一遍（决策 22）。
    expect(screen.getByText(DAEMON_ACTIVE_TURNS_WORDING)).toBeTruthy();

    // 点它只打开确认，一次调用都不发。
    fireEvent.click(action);
    await advance(0);
    expect(upgradeCalls).toHaveLength(1);
    expect(screen.getByText("2 conversation(s) still running")).toBeTruthy();

    fireEvent.click(screen.getByTestId("device-upgrade-confirm-1"));
    await advance(0);
    expect(upgradeCalls).toEqual([
      { device_id: 1, force: false },
      { device_id: 1, force: true },
    ]);
    expect(screen.getByText("Upgrading to 0.6.0")).toBeTruthy();
  });
});

describe("窄屏也要成立", () => {
  it("移动端卡片同样出弱徽标与展开区的升级出口", async () => {
    mockConsole({
      devices: () => [AGENTRED_UPGRADABLE],
      latest: { known: true, version: "0.6.0" },
    });
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      renderDevices();
      await screen.findByText("build-box-02");
      const row = screen
        .getByText("build-box-02")
        .closest('[data-slot="card"]') as HTMLElement;
      expect(
        within(row).getByTestId("device-version-badge-1").textContent,
      ).toContain("Upgradable to 0.6.0");

      await expandRow(1);
      expect(
        within(row).getByTestId("device-upgrade-action-1").textContent,
      ).toContain("Upgrade agentred");
      expect(
        within(row).getByTestId("device-upgrade-command-1").textContent,
      ).toContain("agentred update");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
