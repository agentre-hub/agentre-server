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
      name: "study-nuc",
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

describe("device row expand", () => {
  it("expanding an agentred row shows runnable agents with rank and configured-only projects", async () => {
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
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("study-nuc");

    const card = screen
      .getByText("study-nuc")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );

    expect(
      await within(card).findByText("Agents that can run here"),
    ).toBeTruthy();
    expect(within(card).getByText("Frontend Agent")).toBeTruthy();
    expect(within(card).getByText("Rank 2")).toBeTruthy();
    expect(within(card).getByText("agentre-server")).toBeTruthy();
    // agentred 展开不解释「为什么没有 Agent 一节」——它本来就有。
    expect(within(card).queryByText(/belong to the account/i)).toBeNull();
  });

  it("expanding a desktop row lists every account project, configured or not, with no agents section", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=2") {
        return {
          device_id: 2,
          kind: "desktop",
          projects: [
            { sync_id: "proj-1", name: "agentre-server", configured: true },
            { sync_id: "proj-2", name: "agentre-hub", configured: false },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("laptop");

    const card = screen
      .getByText("laptop")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );

    expect(await within(card).findByText("agentre-server")).toBeTruthy();
    expect(within(card).getByText("agentre-hub")).toBeTruthy();
    expect(within(card).getByText("Configured")).toBeTruthy();
    expect(within(card).getByText("Not configured")).toBeTruthy();
    expect(within(card).queryByText("Agents that can run here")).toBeNull();
    // 桌面端展开要说明「为什么这里没有 Agent」。
    expect(within(card).getByText(/belong to the account/i)).toBeTruthy();
  });

  it("collapsing hides the detail again without refetching on re-expand", async () => {
    let calls = 0;
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=1") {
        calls += 1;
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
    await screen.findByText("study-nuc");
    const card = screen
      .getByText("study-nuc")
      .closest('[data-slot="card"]') as HTMLElement;

    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );
    await within(card).findByText("No agents can run on this device yet.");

    fireEvent.click(
      within(card).getByRole("button", { name: /hide details/i }),
    );
    expect(
      within(card).queryByText("No agents can run on this device yet."),
    ).toBeNull();

    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );
    await within(card).findByText("No agents can run on this device yet.");

    expect(calls).toBe(1);
  });

  // R19 守卫：项目行只展示名字与「已配置」这个布尔事实。即便 API 响应里意外
  // 带了路径字段，页面渲染出的文本也绝不能出现它。
  it("never renders a path value even if the detail response carries one", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=2") {
        return {
          device_id: 2,
          kind: "desktop",
          projects: [
            {
              sync_id: "proj-1",
              name: "agentre-server",
              configured: true,
              // 真实 API 从不会发这个字段；这里故意塞进去验证组件不会画出来。
              path: "/Users/wyz/Code/agentre/agentre-server",
            },
          ],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    await screen.findByText("laptop");
    const card = screen
      .getByText("laptop")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );
    await within(card).findByText("agentre-server");

    expect(card.textContent ?? "").not.toContain("/Users/wyz");
  });
});
