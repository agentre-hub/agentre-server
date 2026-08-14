import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";
import Devices from "@/pages/Devices";
import { deviceKindIcon } from "@/lib/deviceKind";
import { Laptop, Monitor, Server } from "lucide-react";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// 副行 cardSummary 的「对话在跑」数要真去问那台 agentred（与 DeviceSessionCounts
// 同一真相源）：3 条会话里 2 条 running。
vi.mock("@/hooks/use-relay", () => ({
  useRelayMachine: (fingerprint: string | null) => ({
    client: fingerprint
      ? {
          request: async () => ({
            sessions: [
              {
                sessionId: 1,
                lifecycleState: "running",
                latestSeq: 1,
                waitingForInput: true,
              },
              { sessionId: 2, lifecycleState: "idle", latestSeq: 1 },
              { sessionId: 3, lifecycleState: "running", latestSeq: 1 },
            ],
            supportsSessionMetadata: true,
          }),
        }
      : null,
    relayState: fingerprint ? "connected" : "disconnected",
    webDevice: null,
    webDeviceError: null,
  }),
}));

const mockedApi = vi.mocked(api);

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
});

describe("device page design alignment", () => {
  it("TopBar 注入设备总数 Cnt；有在线 agentred 时显示 Fresh『桌面端已连接』", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    // Cnt = 设备总数（font-mono，text-subtle-foreground）
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

    // 危险卡标题/正文都不该出现（revokeCardTitle='Revoke this device' 无问号，
    // 与对话框标题 'Revoke this device?' 区分开；对话框此刻未打开）。
    expect(screen.queryByText("Revoke this device")).toBeNull();
    expect(screen.queryByText(/can no longer refresh/i)).toBeNull();

    // 撤销入口在每台可撤销设备的行级菜单里
    const nuc = screen
      .getByText("nuc-01")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(within(nuc).getByRole("button", { name: "Row actions" }));
    const menu = await within(nuc).findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Revoke" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Revoke this device?")).toBeTruthy();
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
    expect(deviceKindIcon("web")).toBe(Monitor);
  });
});

// 规格「web 控制台：设备页 · 入口与展开条件」：整页只有一个「添加设备」入口，
// 点它就地在列表上方展开三步引导；空态默认展开并取代那句孤立的空句；
// 列表加载失败时只留既有错误 —— 不展开引导，也不改口说没有设备。
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
