import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrCodeInternal } from "@agentre-hub/agentre-wire";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

import App from "@/App";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { listPortForwards } from "@/lib/portForward";
import { RelayError } from "@/lib/relayClient";
import Devices from "@/pages/Devices";

/**
 * 设备页手机形态（规格 2026-11-05「设备」，决策 15）：在线 / 离线分组的列表、
 * 逐层进入的独立详情页（替代原地展开）、整屏三步的添加设备。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// 计数问的是那台机器（session.counts）；每个目标一份稳定的 client，见 devices.test。
vi.mock("@/hooks/use-relay", () => {
  const counts = { total: 3n, running: 2n, waiting: 1n };
  const perTarget = new Map<string, unknown>();
  return {
    useRelayChannel: (target: string | null) => {
      const key = target ?? "";
      if (!perTarget.has(key)) {
        perTarget.set(key, {
          client: target ? { request: async () => counts } : null,
          relayState: target ? "connected" : "disconnected",
          relayTicket: null,
          relayTicketError: null,
          handshakeRejection: null,
        });
      }
      return perTarget.get(key);
    },
  };
});

vi.mock("@/lib/portForward", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portForward")>();
  return { ...actual, listPortForwards: vi.fn(async () => []) };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);
const mockedList = vi.mocked(listPortForwards);

const workstation = {
  id: 1,
  name: "ws-raw-host",
  display_name: "Workstation",
  kind: "agentred",
  platform: "linux",
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
const macMini = {
  ...workstation,
  id: 2,
  name: "mac-mini",
  display_name: "",
  version: "0.6.0",
  fingerprint: "fp-2",
};
const laptop = {
  ...workstation,
  id: 3,
  name: "laptop",
  display_name: "",
  kind: "desktop",
  platform: "darwin",
  version: "0.3.0",
  fingerprint: "fp-3",
  online: false,
  last_seen_at: Date.now() - 3 * 3600_000,
};

const detail = {
  device_id: 1,
  kind: "agentred",
  runnable_agents: [{ sync_id: "a-1", name: "Backend Agent", rank: 1 }],
  projects: [
    { sync_id: "p-1", name: "agentre-server", configured: true },
    { sync_id: "p-2", name: "migrations", configured: false },
  ],
};

function mockConsole(devices: unknown[] = [workstation, macMini, laptop]) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/devices") return { devices };
    if (path === "/v1/release/latest") return { known: true, version: "0.6.0" };
    if (path.startsWith("/v1/workspace/device-detail")) return detail;
    throw new Error("unexpected call: " + path);
  });
}

function setMobile(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function Where() {
  const { pathname } = useLocation();
  return <span data-testid="where">{pathname}</span>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/devices/:deviceId?"
          element={
            <>
              <Devices />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

const originalMatchMedia = window.matchMedia;
const originalShare = (navigator as { share?: unknown }).share;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockedList.mockReset();
  mockedList.mockResolvedValue([]);
  setMobile(true);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  if (originalShare === undefined) {
    delete (navigator as { share?: unknown }).share;
  } else {
    (navigator as { share?: unknown }).share = originalShare;
  }
});

describe("手机设备列表", () => {
  it("按在线 / 离线分组，状态写成字，行不原地展开", async () => {
    mockConsole();
    renderAt("/devices");

    const online = await screen.findByRole("region", { name: "Online" });
    const offline = screen.getByRole("region", { name: "Offline" });
    expect(within(online).getByText("Workstation")).toBeTruthy();
    expect(within(online).getByText("mac-mini")).toBeTruthy();
    expect(within(offline).getByText("laptop")).toBeTruthy();

    // 「在线 · 版本 · 可以升级」
    const ws = screen.getByTestId("device-row-1");
    expect(ws.textContent).toContain("Online");
    expect(ws.textContent).toContain("0.5.2");
    expect(await within(ws).findByText(/Upgrade available/)).toBeTruthy();
    expect(screen.getByTestId("device-row-2").textContent).not.toContain(
      "Upgrade available",
    );
    // 「Agentre 没有运行 · 几小时前」
    const lp = screen.getByTestId("device-row-3");
    expect(lp.textContent).toContain("Agentre is not running");
    expect(lp.textContent).toMatch(/3 hours ago|3h/);

    // 手机上点一行是进详情，不是原地展开。
    expect(screen.queryByTestId("device-expand-1")).toBeNull();
  });

  it("页头：标题、「N / M 台在线」、＋ 打开添加设备", async () => {
    mockConsole();
    renderAt("/devices");
    await screen.findByText("Workstation");

    const header = screen.getByTestId("devices-mobile-header");
    expect(within(header).getByText("Devices")).toBeTruthy();
    expect(within(header).getByText("2 / 3 online")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Open menu" }));
    fireEvent.click(within(header).getByRole("button", { name: "Add device" }));
    expect(screen.getByTestId("add-device-guide")).toBeTruthy();
  });

  it("点一行进入 /devices/:id", async () => {
    mockConsole();
    renderAt("/devices");
    fireEvent.click(await screen.findByTestId("device-row-1"));
    expect(screen.getByTestId("where").textContent).toBe("/devices/1");
    expect(await screen.findByTestId("device-detail-mobile")).toBeTruthy();
  });
});

describe("手机设备详情页", () => {
  it("页头返回 + 名字 + 状态行；可以升级时顶部一行动作；分组列出对话、Agent、项目", async () => {
    mockConsole();
    renderAt("/devices/1");

    const page = await screen.findByTestId("device-detail-mobile");
    const header = within(page).getByTestId("device-detail-header");
    expect(within(header).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(header).getByText("Workstation")).toBeTruthy();
    expect(within(header).getByText(/Online · 0\.5\.2 · linux/)).toBeTruthy();
    // 行菜单（改名 / 解除授权）在页头。
    expect(within(header).getByTestId("device-menu-1-trigger")).toBeTruthy();

    // 「可以升级时顶部一行动作」：一行（标题 + 动作），不是展开区那张带说明与命令卡的面板。
    const upgrade = await within(page).findByTestId("device-upgrade-1");
    expect(within(upgrade).getByTestId("device-upgrade-action-1")).toBeTruthy();
    expect(
      within(upgrade).queryByTestId("device-upgrade-command-1"),
    ).toBeNull();
    expect(
      within(upgrade).queryByText(/restarts agentred|重启 agentred/),
    ).toBeNull();

    const sessions = within(page).getByRole("region", {
      name: "Conversations",
    });
    const link = await within(sessions).findByTestId("device-sessions-link-1");
    expect(link.getAttribute("href")).toBe("/devices/1/sessions");
    expect(await within(link).findByText("3 conversations")).toBeTruthy();

    const agents = within(page).getByRole("region", {
      name: "Agents that can run here",
    });
    expect(await within(agents).findByText("Backend Agent")).toBeTruthy();
    expect(within(agents).getByText("Rank 1")).toBeTruthy();

    const projects = within(page).getByRole("region", { name: "Projects" });
    expect(within(projects).getByText("agentre-server")).toBeTruthy();
    expect(within(projects).getByText("Not configured")).toBeTruthy();
  });

  it("在详情页点升级、版本随后翻新：「升级完成」那一行留在页上，不随版本变成最新一起消失", async () => {
    let version = "0.5.2";
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices")
        return { devices: [{ ...workstation, version }] };
      if (path === "/v1/release/latest")
        return { known: true, version: "0.6.0" };
      if (path.startsWith("/v1/workspace/device-detail")) return detail;
      if (path === "/v1/devices/upgrade")
        return { accepted: true, target_version: "0.6.0" };
      throw new Error("unexpected call: " + path);
    });
    // 升级受理后每 5 秒回读一次版本：接住那只定时器，由用例决定何时回读；别的
    // 定时器照常走。
    const polls: Array<() => void> = [];
    const realSetInterval = window.setInterval.bind(window);
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms !== 5_000) return realSetInterval(fn, ms);
      polls.push(fn);
      return 1;
    }) as typeof window.setInterval);
    try {
      renderAt("/devices/1");
      const page = await screen.findByTestId("device-detail-mobile");
      fireEvent.click(
        await within(page).findByTestId("device-upgrade-action-1"),
      );
      await waitFor(() => expect(polls).toHaveLength(1));

      version = "0.6.0";
      await act(async () => {
        polls[0]();
      });

      expect(await within(page).findByText("Upgrade complete")).toBeTruthy();
      expect(
        within(page).getByTestId("device-upgrade-versions-1").textContent,
      ).toBe("0.5.2 → 0.6.0");
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("已是最新时没有升级那一行", async () => {
    mockConsole();
    renderAt("/devices/2");
    const page = await screen.findByTestId("device-detail-mobile");
    await within(page).findByText("Backend Agent");
    expect(within(page).queryByTestId("device-upgrade-2")).toBeNull();
  });

  it("端口转发取不到：失败行说什么没成 + 重试 / 复制诊断信息，不贴机器原话", async () => {
    mockConsole();
    mockedList.mockRejectedValue(
      new RelayError(ErrCodeInternal, "raw: socket exploded at 0xdeadbeef"),
    );
    renderAt("/devices/1");
    const page = await screen.findByTestId("device-detail-mobile");

    const alert = await within(page).findByRole("alert");
    expect(alert.textContent).toMatch(/port mappings/);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      within(alert).getByRole("button", { name: "Copy diagnostics" }),
    ).toBeTruthy();
    expect(page.textContent).not.toContain("0xdeadbeef");
  });

  it("离线的桌面端：不给对话入口，说 Agentre 没有运行", async () => {
    mockConsole();
    renderAt("/devices/3");
    const page = await screen.findByTestId("device-detail-mobile");
    expect(
      within(page).getByTestId("device-detail-header").textContent,
    ).toContain("Agentre is not running");
    expect(
      await within(page).findByText(/Agentre is not running on this computer/),
    ).toBeTruthy();
    expect(within(page).queryByTestId("device-sessions-link-3")).toBeNull();
  });

  it("App 路由 /devices/:deviceId 接到详情页", async () => {
    const me = {
      user_id: 1,
      email: "dev@agentre.dev",
      display_name: "Dev",
      avatar_url: "",
      github_login: "dev",
      csrf_token: "t",
    };
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/me") return me;
      if (path === "/v1/devices") return { devices: [workstation] };
      if (path === "/v1/release/latest") return { known: false };
      if (path.startsWith("/v1/workspace/device-detail")) return detail;
      return {};
    });
    window.history.pushState({}, "", "/devices/1");
    try {
      render(<App />, { wrapper: ThemeProvider });
      expect(await screen.findByTestId("device-detail-mobile")).toBeTruthy();
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("桌面宽度下 /devices/:id 回到列表、仍是原地展开", async () => {
    setMobile(false);
    mockConsole();
    renderAt("/devices/1");
    expect(await screen.findByTestId("device-expand-1")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/devices");
    expect(screen.queryByTestId("device-detail-mobile")).toBeNull();
  });
});

describe("手机添加设备：整屏三步", () => {
  async function openGuide() {
    mockConsole();
    renderAt("/devices");
    await screen.findByText("Workstation");
    fireEvent.click(screen.getByRole("button", { name: "Add device" }));
    return screen.getByTestId("add-device-guide");
  }

  it("整屏：列表让位；进度条、标题 + 一句、chips、命令卡，下一步钉底，✕ 关闭", async () => {
    const guide = await openGuide();
    expect(screen.queryByTestId("device-row-1")).toBeNull();

    // 进度条是紧凑档：三格只画序号徽标，不带标题副行。
    const step1 = within(guide).getByRole("button", { name: /^Step 1/ });
    expect(step1.getAttribute("aria-current")).toBe("step");
    expect(within(step1).queryByText("Install and sign in")).toBeNull();

    expect(
      within(guide).getByText("Install agentred and sign in"),
    ).toBeTruthy();
    // 选项 chips：设备类型、系统。
    const kind = within(guide).getByRole("button", {
      name: "Compute node (agentred)",
    });
    expect(kind.getAttribute("aria-pressed")).toBe("true");
    expect(kind.className).toContain("rounded-full");
    expect(within(guide).getByRole("button", { name: "macOS" })).toBeTruthy();
    // 每屏一张命令卡：装与登录并在同一张里（装在上、登录在下），一次复制。
    expect(within(guide).getAllByRole("group")).toHaveLength(1);
    const command =
      within(guide).getByTestId("add-device-command-install").textContent ?? "";
    expect(command.split("\n")).toHaveLength(2);
    expect(command.split("\n")[1]).toContain("agentred login");

    const footer = within(guide).getByTestId("add-device-footer");
    expect(footer.className).toMatch(/(^|\s)sticky(\s|$)/);
    fireEvent.click(
      within(footer).getByRole("button", { name: /I have the device code/ }),
    );
    expect(
      within(guide)
        .getByRole("button", { name: /^Step 2/ })
        .getAttribute("aria-current"),
    ).toBe("step");

    fireEvent.click(within(guide).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("add-device-guide")).toBeNull();
    expect(screen.getByTestId("device-row-1")).toBeTruthy();
  });

  it("前进到第 3 步、再从进度条退回第 1 步", async () => {
    const guide = await openGuide();
    fireEvent.click(within(guide).getByRole("button", { name: /^Step 3/ }));
    expect(
      within(guide).getByText("Keep agentred running in the background"),
    ).toBeTruthy();
    expect(
      within(guide).getByTestId("add-device-command-service"),
    ).toBeTruthy();
    // 紧凑档的常驻段只留一张命令卡（状态、重启不画）。
    expect(within(guide).getAllByRole("group")).toHaveLength(1);

    fireEvent.click(within(guide).getByRole("button", { name: /^Step 1/ }));
    expect(
      within(guide).getByText("Install agentred and sign in"),
    ).toBeTruthy();
  });

  it("浏览器不支持系统分享时不出「发到电脑上」", async () => {
    delete (navigator as { share?: unknown }).share;
    const guide = await openGuide();
    expect(
      within(guide).queryByRole("button", { name: /Send to computer/ }),
    ).toBeNull();
  });

  it("支持系统分享时「发到电脑上」把这一屏的命令交给系统分享", async () => {
    const share = vi.fn(async () => {});
    (navigator as { share?: unknown }).share = share;
    const guide = await openGuide();
    fireEvent.click(
      within(guide).getByRole("button", { name: /Send to computer/ }),
    );
    expect(share).toHaveBeenCalledTimes(1);
    const text = (share.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(text).toContain(
      within(guide).getByTestId("add-device-command-install").textContent,
    );
    expect(text).toContain("agentred login");
  });

  it("一台设备都没有时，三步就是这一页（不给 ✕），页头仍可开抽屉", async () => {
    mockConsole([]);
    renderAt("/devices");
    const guide = await screen.findByTestId("add-device-guide");
    expect(within(guide).queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
  });

  it("进入第 2 步不先报「请填满 6 位代码」：没输入也没提交就不出错误态", async () => {
    const guide = await openGuide();
    fireEvent.click(
      within(guide).getByRole("button", { name: /I have the device code/ }),
    );
    expect(
      within(guide)
        .getByRole("button", { name: /^Step 2/ })
        .getAttribute("aria-current"),
    ).toBe("step");
    expect(within(guide).queryByText("Enter all six characters.")).toBeNull();
    expect(
      within(guide)
        .getAllByRole("textbox")
        .some((box) => box.getAttribute("aria-invalid")),
    ).toBe(false);
  });

  it("第 1 步的「下一步」与第 2 步的提交键是两个 DOM 节点：点完第 1 步不会复用同一个按钮", async () => {
    // 同一位置的三个 footer 按钮若共用一个节点，点「下一步」的那次 click 会在
    // 节点被 React 复用后落到它身上，表现为提交空码。两步的按钮必须是不同节点。
    const guide = await openGuide();
    const footer = within(guide).getByTestId("add-device-footer");
    const next = within(footer).getByRole("button", {
      name: /I have the device code/,
    });
    fireEvent.click(next);
    const submit = within(footer).getByRole("button", { name: "Continue" });
    expect(submit).not.toBe(next);
    expect(within(guide).queryByText("Enter all six characters.")).toBeNull();
  });

  it("第 2 步输入中不出错误态；只有提交不足六位才出现「请填满 6 位代码」", async () => {
    const guide = await openGuide();
    fireEvent.click(
      within(guide).getByRole("button", { name: /I have the device code/ }),
    );
    fireEvent.change(within(guide).getAllByRole("textbox")[0], {
      target: { value: "A" },
    });
    expect(within(guide).queryByText("Enter all six characters.")).toBeNull();

    fireEvent.click(within(guide).getByRole("button", { name: "Continue" }));
    expect(
      await within(guide).findByText("Enter all six characters."),
    ).toBeTruthy();
  });
});
