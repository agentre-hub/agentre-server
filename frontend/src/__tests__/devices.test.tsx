import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import i18n from "@/i18n";
import Devices from "@/pages/Devices";

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
    expect(screen.getByTestId("devices-count").textContent).toBe("2");
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

  it("右列 340px 危险卡：标题/正文/撤销按钮，点击走现有撤销 Dialog", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("nuc-01");

    // 危险卡标题/正文（revokeCardTitle / revokeCardBody）
    expect(screen.getByText("Revoke this device")).toBeTruthy();
    expect(
      screen.getByText(/can no longer refresh its credentials/i),
    ).toBeTruthy();

    // 页面唯一「Revoke」= 危险卡按钮 → 打开既有撤销 Dialog
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Revoke this device?")).toBeTruthy();
  });

  it("设备卡结构：标题行（名 + 类型 chip + 状态）+ 右上 Meta（platform·version·last-active）", async () => {
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
    expect(within(nuc).getByText(/Online/)).toBeTruthy(); // 状态
    expect(within(nuc).getByText(/linux/)).toBeTruthy(); // Meta platform
    expect(within(nuc).getByText(/0\.4\.0/)).toBeTruthy(); // Meta version
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
});
