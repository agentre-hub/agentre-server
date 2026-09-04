import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rpcMethods } from "@agentre-hub/agentre-wire";

import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import Devices from "@/pages/Devices";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// 展开一台在线 agentred 时，「对话」一节的条数与等待数要真去问那台机器（帧 47）——
// 问的是**三个数**（session.counts），不是把整份清单拉过来自己数：那台机器上可能
// 有几千条对话，为三个数搬一遍摘要正是设备页变卡的原因。
const relayRequest = vi.fn(async (method: unknown) => {
  if (method !== rpcMethods.sessionCounts) {
    throw new Error("unexpected method");
  }
  return { total: 3n, running: 2n, waiting: 1n };
});

vi.mock("@/hooks/use-relay", () => ({
  useRelayMachine: (target: string | null) => ({
    client: target ? { request: relayRequest } : null,
    relayState: target ? "connected" : "disconnected",
    relayTicket: null,
    relayTicketError: null,
    handshakeRejection: null,
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
  });

  // 界面（mockup 帧 47）：设备页展开一台 agentred 时多一节「对话」，给出条数、
  // 等待处理数与「查看这台机器的对话」入口。条数与等待数要真去问那台机器。
  it("expanding an agentred row shows the conversation counts from that machine", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=1") {
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

    // 3 条会话，其中 1 条等你处理。
    expect(await within(card).findByText("3 conversations")).toBeTruthy();
    expect(within(card).getByText("1 waiting for you")).toBeTruthy();
    expect(within(card).getByText(/View this machine/i)).toBeTruthy();
  });

  it("expanding an active desktop row shows conversation counts and an enter action", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") {
        return {
          devices: [
            {
              ...listResponse.devices[1],
              online: true,
              is_this_device: false,
            },
          ],
        };
      }
      if (path === "/v1/workspace/device-detail?device_id=2") {
        return {
          device_id: 2,
          kind: "desktop",
          projects: [],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    const card = (await screen.findByText("laptop")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );

    expect(await within(card).findByText("Conversations")).toBeTruthy();
    expect(await within(card).findByText("3 conversations")).toBeTruthy();
    expect(within(card).getByText("1 waiting for you")).toBeTruthy();
    const link = within(card).getByRole("link", {
      name: "View this desktop's conversations",
    });
    expect(link.getAttribute("href")).toBe("/devices/2/sessions");
  });

  it("an inactive desktop says Agentre is not running and cannot be entered", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return listResponse;
      if (path === "/v1/workspace/device-detail?device_id=2") {
        return {
          device_id: 2,
          kind: "desktop",
          projects: [],
        };
      }
      throw new Error("unexpected call: " + path);
    });

    renderDevices();
    const card = (await screen.findByText("laptop")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    expect(within(card).getByText(/Agentre is not running/)).toBeTruthy();
    expect(within(card).queryByText(/^Offline$/)).toBeNull();

    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );
    expect(
      await within(card).findByText(
        /Agentre is not running on this computer\. Open Agentre to view its conversations\./,
      ),
    ).toBeTruthy();
    expect(within(card).queryByRole("link", { name: /conversations/i })).toBe(
      null,
    );
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

  // 取失败不该被当成「已经取过了」缓存下来：页面上没有重试按钮，缓存住失败等于
  // 这一行的详情在整个页面生命周期里永久坏掉，只能整页刷新。
  it("retries the detail fetch after a failed one instead of caching the error", async () => {
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
    await screen.findByText("study-nuc");
    const card = screen
      .getByText("study-nuc")
      .closest('[data-slot="card"]') as HTMLElement;

    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );
    await within(card).findByText(/could not load this device's details/i);

    fireEvent.click(
      within(card).getByRole("button", { name: /hide details/i }),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: /show details/i }),
    );

    await within(card).findByText("No agents can run on this device yet.");
    expect(calls).toBe(2);
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
