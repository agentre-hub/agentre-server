/**
 * 设备卡展开区的「端口转发」小节（规格 2026-09-09 决策 4 / 11 / 12）。
 *
 * 桩打在**中继客户端那一层**（`@/lib/relayClient` 的 RelayClient），不是在组件上
 * 塞一个已经贴好结果的假 port：这样从「点一下」到「发出哪个 wire 方法、带什么参数」
 * 整条生产通路都在用例里跑 —— 页面 → `DevicePortForward` → `@/lib/portForward`
 * → `relayClientPool` → 通道。绕过其中任何一段，这一节最容易出的那类错（方法选错、
 * 参数形状不对、地址拼错）就没有任何东西会红。
 *
 * 行的渲染归共享包 `PortForwardSection`（它自己有用例），这里断言的是**宿主这一半**：
 * 请求发对了、地址是 `/fw/<device_id>/<port>/`、离线不出新增入口、停用行不出「打开」。
 */
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { api } from "@/lib/api";
import { relayClientPool } from "@/lib/relayClientPool";
import { ensureRelayTicket } from "@/lib/relayTicket";
import Devices from "@/pages/Devices";
import { installClipboard, restoreClipboardEnv } from "@/test/clipboard";

const relay = vi.hoisted(() => ({
  connect: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  reopen: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/relayTicket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayTicket")>();
  return { ...actual, ensureRelayTicket: vi.fn() };
});

// RelayError 保持真身：`@/lib/portForward` 按 `instanceof` + 错误码分辨失败，
// 换成一个同名的替身就等于把那段分辨逻辑从用例里摘掉。
vi.mock("@/lib/relayClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayClient")>();
  return {
    ...actual,
    RelayClient: class {
      state = "connected";
      connect = relay.connect;
      request = relay.request;
      close = relay.close;
      reopen = relay.reopen;
    },
  };
});

const mockedApi = vi.mocked(api);
const mockedEnsureRelayTicket = vi.mocked(ensureRelayTicket);

/** 那台在线 agentred 的数字 id —— 地址里用的就是它（决策 4）。 */
const ONLINE_ID = 12;
const OFFLINE_ID = 13;

function devicesResponse() {
  return {
    devices: [
      {
        id: ONLINE_ID,
        name: "study-nuc",
        kind: "agentred",
        platform: "linux",
        version: "0.5.0",
        fingerprint: "fp-online",
        last_seen_at: 1754000000000,
        status: 1,
        online: true,
        is_this_device: false,
      },
      {
        id: OFFLINE_ID,
        name: "attic-box",
        kind: "agentred",
        platform: "linux",
        version: "0.5.0",
        fingerprint: "fp-offline",
        last_seen_at: 1753990000000,
        status: 1,
        online: false,
        is_this_device: false,
      },
    ],
  };
}

function detailResponse(deviceId: number) {
  return {
    device_id: deviceId,
    kind: "agentred",
    runnable_agents: [],
    projects: [],
  };
}

interface WireMapping {
  id: bigint;
  port: number;
  name: string;
  enabled: boolean;
  createtime: bigint;
  updatetime: bigint;
}

function wireMapping(over: Partial<WireMapping> = {}): WireMapping {
  return {
    id: 7n,
    port: 3000,
    name: "Vite dev server",
    enabled: true,
    createtime: 0n,
    updatetime: 0n,
    ...over,
  };
}

/** 这一轮 relay 要答的东西。每条用例只改自己关心的那一格。 */
let listed: WireMapping[] = [];
let created: WireMapping = wireMapping();
let toggled: WireMapping = wireMapping({ enabled: false });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  relayClientPool.closeAll();
  mockedApi.mockReset();
  mockedEnsureRelayTicket.mockReset();
  relay.connect.mockReset();
  relay.request.mockReset();
  relay.close.mockReset();
  relay.connect.mockResolvedValue(undefined);
  mockedEnsureRelayTicket.mockResolvedValue({
    accessToken: "ticket",
    expiresAt: Date.now() + 120_000,
    peerFingerprint: "browser-fp",
    clientName: "Browser",
  });

  listed = [wireMapping()];
  created = wireMapping();
  toggled = wireMapping({ enabled: false });

  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/devices") return devicesResponse();
    if (path === `/v1/workspace/device-detail?device_id=${ONLINE_ID}`) {
      return detailResponse(ONLINE_ID);
    }
    if (path === `/v1/workspace/device-detail?device_id=${OFFLINE_ID}`) {
      return detailResponse(OFFLINE_ID);
    }
    throw new Error("unexpected call: " + path);
  });

  relay.request.mockImplementation(async (method: unknown) => {
    if (method === rpcMethods.sessionCounts) {
      return { total: 0n, waiting: 0n, running: 0n };
    }
    if (method === rpcMethods.portForwardList) return { mappings: listed };
    if (method === rpcMethods.portForwardCreate) return { mapping: created };
    if (method === rpcMethods.portForwardSetEnabled) {
      return { mapping: toggled };
    }
    if (method === rpcMethods.portForwardDelete) return { deleted: true };
    throw new Error("unexpected relay method");
  });
});

afterEach(() => {
  restoreClipboardEnv();
  vi.restoreAllMocks();
});

function renderDevices() {
  return render(
    <MemoryRouter>
      <Devices />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

/** 展开那台设备的卡片，交回卡片元素。 */
async function expandDevice(name: string): Promise<HTMLElement> {
  renderDevices();
  await screen.findByText(name);
  const card = screen
    .getByText(name)
    .closest('[data-slot="card"]') as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: /show details/i }));
  return card;
}

/** 那一节的行。 */
function rowsIn(card: HTMLElement): HTMLElement[] {
  return Array.from(
    card.querySelectorAll('[data-slot="port-forward-row"]'),
  ) as HTMLElement[];
}

/** 一次 relay 调用的参数：断言方法选对了、参数形状也对。 */
function callFor(method: unknown): unknown {
  const call = relay.request.mock.calls.find(([m]) => m === method);
  return call?.[1];
}

describe("设备卡的端口转发小节", () => {
  it("Given 这台设备上一条映射都没有, When 展开设备卡, Then 空态说这件事并给出新增入口", async () => {
    listed = [];
    const card = await expandDevice("study-nuc");

    expect(
      await within(card).findByText("No port mappings on this device yet."),
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Add mapping" }),
    ).toBeTruthy();
  });

  it("Given 新增表单填好, When 提交, Then 按端口与名称发出 portForwardCreate 并把新行列出来", async () => {
    listed = [];
    created = wireMapping({ id: 9n, port: 5173, name: "Storybook" });
    const card = await expandDevice("study-nuc");

    fireEvent.click(
      await within(card).findByRole("button", { name: "Add mapping" }),
    );
    fireEvent.change(within(card).getByLabelText("Port"), {
      target: { value: "5173" },
    });
    fireEvent.change(within(card).getByLabelText("Name"), {
      target: { value: "Storybook" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(callFor(rpcMethods.portForwardCreate)).toEqual({
        port: 5173,
        name: "Storybook",
      });
    });
    const row = await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    });
    expect(row.textContent).toContain("5173");
    expect(row.textContent).toContain("Storybook");
  });

  it("Given 一条启用中的映射, When 关掉它的开关, Then 按 id 发出 portForwardSetEnabled(false) 并把行改成停用", async () => {
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    fireEvent.click(within(row).getByRole("switch"));

    await waitFor(() => {
      expect(callFor(rpcMethods.portForwardSetEnabled)).toEqual({
        id: 7n,
        enabled: false,
      });
    });
    await waitFor(() => {
      expect(rowsIn(card)[0].dataset.enabled).toBe("false");
    });
  });

  it("Given 一条映射, When 从更多操作里删掉它, Then 按 id 发出 portForwardDelete 并把行去掉", async () => {
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    const trigger = within(row).getByRole("button", { name: "More actions" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    if (!screen.queryByRole("menu")) fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(callFor(rpcMethods.portForwardDelete)).toEqual({ id: 7n });
    });
    await waitFor(() => {
      expect(rowsIn(card)).toHaveLength(0);
    });
  });

  it("Given 一条映射, When 点复制, Then 拿到的是这台设备这个端口的访问地址", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: "Copy address" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/fw/${ONLINE_ID}/3000/`,
      );
    });
  });

  it("Given 一条启用中的映射, When 点「打开」, Then 在新标签页打开 /fw/<device_id>/<port>/", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    fireEvent.click(
      within(row).getByRole("button", { name: "Open in a new tab" }),
    );

    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/fw/${ONLINE_ID}/3000/`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("Given 设备离线, When 展开设备卡, Then 说明离线且不出新增入口（也不去问那台机器）", async () => {
    const card = await expandDevice("attic-box");

    expect(
      await within(card).findByText(/Offline — forwarding is unavailable\./),
    ).toBeTruthy();
    expect(
      within(card).queryByRole("button", { name: "Add mapping" }),
    ).toBeNull();
    expect(
      relay.request.mock.calls.some(([m]) => m === rpcMethods.portForwardList),
    ).toBe(false);
  });

  it("Given 一条已停用的映射, When 它被列出来, Then 整行保留但不出「打开」", async () => {
    listed = [wireMapping({ enabled: false })];
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    expect(row.textContent).toContain("3000");
    expect(row.dataset.enabled).toBe("false");
    expect(
      within(row).queryByRole("button", { name: "Open in a new tab" }),
    ).toBeNull();
  });
});
