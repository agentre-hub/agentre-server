/**
 * 设备卡展开区的「端口转发」小节（规格 2026-09-21-port-forward-subdomain
 * 「控制台界面」）。
 *
 * 声明族（list / create / setEnabled / delete）的桩打在**中继客户端那一层**
 * （`@/lib/relayClient` 的 RelayClient），不是在组件上塞一个已经贴好结果的假地址：
 * 这样从「点一下」到「发出哪个 wire 方法、带什么参数」整条生产通路都在用例里跑 ——
 * 页面 → `DevicePortForward` → `@/lib/portForward` → `relayClientPool` → 通道。
 * 分配转发地址这一段打的是本站自己（`POST /v1/port-forwards/links`），桩打在
 * `@/lib/api`——与账号 / 设备列表那些用例同一层。绕过其中任何一段，这一节最容易
 * 出的那类错（方法选错、参数形状不对、地址拼错）就没有任何东西会红。
 *
 * 行与新增表单的渲染归共享包 `PortForwardSection`（它自己有用例），这里断言的是
 * **宿主这一半**：声明请求发对了、分配地址的请求发对了、「打开」「复制地址」第一次
 * 用到时才分配、之后复用同一个串、部署没配 `base_domain` 时报那句话、离线不出新增
 * 入口、停用行不出「打开」。
 */
import {
  ErrCodePortForwardInvalidTarget,
  rpcMethods,
} from "@agentre-hub/agentre-wire";
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
import { ApiError, api } from "@/lib/api";
import { RelayError } from "@/lib/relayClient";
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

/** 那台在线 agentred 的数字 id —— 分配地址的请求体里用的就是它。 */
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
  target: string;
  insecure: boolean;
  createtime: bigint;
  updatetime: bigint;
}

function wireMapping(over: Partial<WireMapping> = {}): WireMapping {
  return {
    id: 7n,
    port: 3000,
    name: "Vite dev server",
    enabled: true,
    target: "http://127.0.0.1:3000",
    insecure: false,
    createtime: 0n,
    updatetime: 0n,
    ...over,
  };
}

/** 这一轮 relay 要答的东西。每条用例只改自己关心的那一格。 */
let listed: WireMapping[] = [];
let created: WireMapping = wireMapping();
let toggled: WireMapping = wireMapping({ enabled: false });

/** 这一轮 `/v1/port-forwards/links` 要答的东西（或抛的失败）。 */
let linkResult: { prefix: string; url: string } | Error = {
  prefix: "abcd1234efgh",
  url: "https://abcd1234efgh.fw.agentre.docker.local:8443/",
};

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
  linkResult = {
    prefix: "abcd1234efgh",
    url: "https://abcd1234efgh.fw.agentre.docker.local:8443/",
  };

  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/devices") return devicesResponse();
    if (path === `/v1/workspace/device-detail?device_id=${ONLINE_ID}`) {
      return detailResponse(ONLINE_ID);
    }
    if (path === `/v1/workspace/device-detail?device_id=${OFFLINE_ID}`) {
      return detailResponse(OFFLINE_ID);
    }
    if (path === "/v1/port-forwards/links" && init?.method === "POST") {
      if (linkResult instanceof Error) throw linkResult;
      return linkResult;
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

/** 打给 `/v1/port-forwards/links` 的每一次调用的请求体。 */
function linkCalls(): unknown[] {
  return mockedApi.mock.calls
    .filter(([path]) => path === "/v1/port-forwards/links")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
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

  it("Given 新增表单填好三种写法之一, When 提交, Then 按目标 + 名称 + insecure 发出 portForwardCreate 并把新行列出来", async () => {
    listed = [];
    created = wireMapping({
      id: 9n,
      port: 5173,
      name: "Storybook",
      target: "http://127.0.0.1:5173",
    });
    const card = await expandDevice("study-nuc");

    fireEvent.click(
      await within(card).findByRole("button", { name: "Add mapping" }),
    );
    fireEvent.change(within(card).getByLabelText("Target"), {
      target: { value: "5173" },
    });
    fireEvent.change(within(card).getByLabelText("Name"), {
      target: { value: "Storybook" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(callFor(rpcMethods.portForwardCreate)).toEqual({
        target: "5173",
        name: "Storybook",
        insecure: false,
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

  it("Given 目标写成显式 https, When 勾上忽略证书错误并提交, Then insecure 为真", async () => {
    listed = [];
    created = wireMapping({
      id: 10n,
      target: "https://192.168.1.5:8443",
      insecure: true,
    });
    const card = await expandDevice("study-nuc");

    fireEvent.click(
      await within(card).findByRole("button", { name: "Add mapping" }),
    );
    fireEvent.change(within(card).getByLabelText("Target"), {
      target: { value: "https://192.168.1.5:8443" },
    });
    fireEvent.click(within(card).getByLabelText(/ignore certificate errors/i));
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(callFor(rpcMethods.portForwardCreate)).toEqual({
        target: "https://192.168.1.5:8443",
        name: "",
        insecure: true,
      });
    });
  });

  it("Given 设备用 -32076 回绝新增（主机语法有问题，表单挡不住）, When 提交, Then 报共享包 @agentre-hub/agentre-ui 持有的那句「无效目标」，与表单即时校验同一句话（规格「映射与目标」声明 + 决策 15）", async () => {
    listed = [];
    relay.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.sessionCounts) {
        return { total: 0n, waiting: 0n, running: 0n };
      }
      if (method === rpcMethods.portForwardList) return { mappings: listed };
      if (method === rpcMethods.portForwardCreate) {
        throw new RelayError(
          ErrCodePortForwardInvalidTarget,
          "portforward: invalid target host",
        );
      }
      throw new Error("unexpected relay method");
    });
    const card = await expandDevice("study-nuc");

    fireEvent.click(
      await within(card).findByRole("button", { name: "Add mapping" }),
    );
    // 主机语法有问题（含 `$`），三种写法的即时校验挡不住（判不全不是 bug），
    // 由设备的 -32076 兜底。
    fireEvent.change(within(card).getByLabelText("Target"), {
      target: { value: "bad$host:1234" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));

    expect(
      await within(card).findByText(
        "Enter a port, host:port, or http(s)://host[:port].",
      ),
    ).toBeTruthy();
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

  it("Given 一条启用中的映射, When 点「打开」, Then 分配前缀并在新标签页打开返回的子域地址", async () => {
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

    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        "https://abcd1234efgh.fw.agentre.docker.local:8443/",
        "_blank",
        "noopener,noreferrer",
      );
    });
    expect(linkCalls()).toEqual([{ device_id: ONLINE_ID, mapping_id: 7 }]);
  });

  it("Given 已经打开过一次（地址已分配）, When 点复制, Then 复制的是同一个串，且没有再打一次分配请求", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    vi.spyOn(window, "open").mockReturnValue(null);
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    fireEvent.click(
      within(row).getByRole("button", { name: "Open in a new tab" }),
    );
    await waitFor(() => expect(linkCalls()).toHaveLength(1));

    fireEvent.click(
      await within(row).findByRole("button", { name: "Copy address" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://abcd1234efgh.fw.agentre.docker.local:8443/",
      );
    });
    // 显示与复制是同一个串，而且第二次用（复制）没有再分配一次前缀。
    expect(linkCalls()).toHaveLength(1);
  });

  it("Given 部署没配 base_domain, When 点「打开」, Then 报『这个部署此刻提供不了端口转发』而不是当成设备离线", async () => {
    linkResult = new ApiError(
      31200,
      "this deployment does not offer port forwarding right now",
      503,
    );
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    fireEvent.click(
      within(row).getByRole("button", { name: "Open in a new tab" }),
    );

    expect(
      await within(card).findByText(
        "this deployment does not offer port forwarding right now",
      ),
    ).toBeTruthy();
    // 这不是「设备够不着」：新增入口还在，行上「打开」也还在——不是离线态。
    expect(
      within(card).queryByRole("button", { name: "Add mapping" }),
    ).toBeTruthy();
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

  it("Given 一条已停用的映射, When 它被列出来, Then 整行保留但不出「打开」, 目标是环回端口只显示端口", async () => {
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

  it("Given 一条映射目标是非环回主机, When 它被列出来, Then 行上显示规范化后的完整目标", async () => {
    listed = [
      wireMapping({
        id: 11n,
        target: "https://192.168.1.5:8443",
        name: "Internal site",
      }),
    ];
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    expect(row.textContent).toContain("https://192.168.1.5:8443");
  });

  it("Given 点「打开」, Then 在分配请求还没回来之前就已经同步开好一个空白标签页（不被弹窗拦截器当成非用户发起）", async () => {
    let resolveLink: (link: { prefix: string; url: string }) => void;
    const linkPromise = new Promise<{ prefix: string; url: string }>(
      (resolve) => {
        resolveLink = resolve;
      },
    );
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/devices") return devicesResponse();
      if (path === `/v1/workspace/device-detail?device_id=${ONLINE_ID}`) {
        return detailResponse(ONLINE_ID);
      }
      if (path === "/v1/port-forwards/links" && init?.method === "POST") {
        return linkPromise;
      }
      throw new Error("unexpected call: " + path);
    });
    const handle = {
      location: { href: "" },
      opener: {} as unknown,
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(handle as unknown as Window);
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    fireEvent.click(
      within(row).getByRole("button", { name: "Open in a new tab" }),
    );

    // 同步断言：这一行跑在分配请求 resolve 之前——`window.open` 必须已经在点击
    // 那一次事件循环里调用过了，标签页还是空白的。
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(handle.opener).toBeNull();
    expect(handle.location.href).toBe("");

    resolveLink!({
      prefix: "abcd1234efgh",
      url: "https://abcd1234efgh.fw.agentre.docker.local:8443/",
    });

    await waitFor(() => {
      expect(handle.location.href).toBe(
        "https://abcd1234efgh.fw.agentre.docker.local:8443/",
      );
    });
  });

  it("Given 分配前缀失败, When 点「打开」, Then 关掉那个空白标签页并按原有失败口径处理", async () => {
    linkResult = new ApiError(
      31200,
      "this deployment does not offer port forwarding right now",
      503,
    );
    const handle = {
      location: { href: "" },
      opener: {} as unknown,
      close: vi.fn(),
    };
    vi.spyOn(window, "open").mockReturnValue(handle as unknown as Window);
    const card = await expandDevice("study-nuc");
    const row = (await waitFor(() => {
      const [first] = rowsIn(card);
      expect(first).toBeTruthy();
      return first;
    })) as HTMLElement;

    fireEvent.click(
      within(row).getByRole("button", { name: "Open in a new tab" }),
    );

    await waitFor(() => {
      expect(handle.close).toHaveBeenCalled();
    });
    expect(
      await within(card).findByText(
        "this deployment does not offer port forwarding right now",
      ),
    ).toBeTruthy();
  });
});
