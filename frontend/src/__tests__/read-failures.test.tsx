/**
 * 各页读失败的统一呈现（规格 2026-11-25 G1、G2、G3；审计 W8、W10、W21、W23、W32）：
 * 原位一行说明 + 44px「重试」；失败时不出「还没有…」空态；对话页名单失败只在顶部加
 * 横幅、保留转录；401 给「重新登录」；吸顶横幅不被转录上沿渐隐遮挡。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rpcMethods } from "@agentre-hub/agentre-wire";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

import { CardLoadError } from "@/components/console";
import SessionDetailView from "@/components/session/SessionDetailView";
import { useRelayChannel } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { api, ApiError, ApiUnavailableError } from "@/lib/api";
import { deviceRoster } from "@/lib/devices";
import Devices from "@/pages/Devices";
import Issues from "@/pages/Issues";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);
const originalMatchMedia = window.matchMedia;

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

beforeEach(async () => {
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  // 设备页的行会问各自机器的计数；这里只关心列表，给一条不通的通道即可。
  mockUseRelay.mockReturnValue({
    client: null,
    relayState: "disconnected",
    relayTicket: null,
    relayTicketError: null,
    handshakeRejection: null,
    reconnect: vi.fn(),
  } as never);
  deviceRoster.invalidate();
  setMobile(true);
  await i18n.changeLanguage("en");
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

/** 按钮的 44px：min-h-11（= 2.75rem = 44px）。 */
const is44 = (el: HTMLElement) => /\bmin-h-11\b/.test(el.className);

describe("失败提示的出口（FailureNotice 经 CardLoadError）", () => {
  function renderCard(error: unknown, path = "/account?tab=x") {
    render(
      <MemoryRouter initialEntries={[path]}>
        <CardLoadError error={error} what="Could not load" onRetry={vi.fn()} />
      </MemoryRouter>,
    );
    return screen.getByRole("alert");
  }

  it("手机上「重试」是 44px", () => {
    const alert = renderCard(new TypeError("Failed to fetch"));
    expect(is44(within(alert).getByRole("button", { name: "Retry" }))).toBe(
      true,
    );
  });

  it("桌面上「重试」保持原尺寸，不被撑到 44px", () => {
    setMobile(false);
    const alert = renderCard(new TypeError("Failed to fetch"));
    expect(is44(within(alert).getByRole("button", { name: "Retry" }))).toBe(
      false,
    );
  });

  it("401：给 44px「重新登录」，指向带 next 的登录页，不给重试", () => {
    const alert = renderCard(new ApiError(30004, "未登录", 401));
    const link = within(alert).getByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe(
      `/login?next=${encodeURIComponent("/account?tab=x")}`,
    );
    expect(is44(link)).toBe(true);
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("非 JSON（502）：说服务暂时不可用并带状态码，不露解析报错", () => {
    const alert = renderCard(
      new ApiUnavailableError("/v1/x", 502, "Unexpected token '<'"),
    );
    expect(alert.textContent).toContain(
      "the service is temporarily unavailable (502)",
    );
    expect(alert.textContent).not.toContain("Unexpected token");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("设备页读失败（W21）", () => {
  const device = {
    id: 1,
    name: "ws",
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
  };

  function mountDevices() {
    return render(
      <MemoryRouter initialEntries={["/devices"]}>
        <Routes>
          <Route path="/devices/:deviceId?" element={<Devices />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: ThemeProvider },
    );
  }

  it.each([
    ["手机", true],
    ["桌面", false],
  ])(
    "%s：列表读不到 → 原位一句 + 重试，不出空态；重试成功后列表出现",
    async (_n, mobile) => {
      setMobile(mobile);
      let failing = true;
      mockedApi.mockImplementation(async (path: string) => {
        if (path === "/v1/devices") {
          if (failing) throw new TypeError("Failed to fetch");
          return { devices: [device] };
        }
        if (path === "/v1/release/latest") return { known: false };
        throw new Error("unexpected: " + path);
      });
      mountDevices();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Could not load your devices");
      expect(screen.queryByText(/no devices/i)).toBeNull();
      expect(screen.queryByTestId("add-device-open")).toBeNull();
      const retry = within(alert).getByRole("button", { name: "Retry" });
      if (mobile) expect(is44(retry)).toBe(true);

      failing = false;
      fireEvent.click(retry);
      expect(await screen.findByText("Workstation")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});

describe("看板读失败（W21）", () => {
  it("读不到：只有失败一行与重试，不同时摆「没有任务」空态", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/workspace/issues"))
        throw new ApiUnavailableError(path, 502, "<html>");
      if (path === "/v1/workspace/projects") return { projects: [] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/workspace/org/backends") return { backends: [] };
      if (path === "/v1/engine/providers") return { providers: [] };
      if (path === "/v1/engine/backends") return { backends: [] };
      if (path === "/v1/devices") return { devices: [] };
      throw new Error("unexpected: " + path);
    });
    render(
      <MemoryRouter initialEntries={["/issues"]}>
        <Issues />
      </MemoryRouter>,
      { wrapper: ThemeProvider },
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("(502)");
    expect(is44(within(alert).getByRole("button", { name: "Retry" }))).toBe(
      true,
    );
    expect(screen.queryByTestId("issue-board")).toBeNull();
  });
});

describe("对话页：设备名单读失败（W8、G3）", () => {
  const deviceRow = {
    id: 1,
    name: "书房小主机",
    kind: "agentred",
    fingerprint: "fp-1",
    last_seen_at: 1754000000000,
    status: 1,
    online: true,
  };
  const summary = {
    conversationId: "42",
    title: "重构登录页",
    agentSyncId: "ag-1",
    cwd: "/home/agent/proj",
    backendType: "claudecode",
    lifecycleState: "idle",
    latestSeq: 1,
  };

  function mount() {
    let onEvent: ((e: unknown) => void) | undefined;
    const client = {
      request: vi.fn(async (method: unknown) => {
        if (method === rpcMethods.sessionList) return { sessions: [summary] };
        if (method === rpcMethods.sessionPendingWaiters)
          return { toolPermissions: [], askUserQuestions: [] };
        throw new Error("unexpected: " + String(method));
      }),
      attach: vi.fn(async () => ({})),
      catchUp: vi.fn(async () => {
        onEvent?.({
          conversationId: "42",
          event: { kind: "text_delta", text: "转录还在" },
          seq: 1,
        });
      }),
      setCursor: vi.fn(),
      getCursor: vi.fn(() => 0),
      close: vi.fn(),
    };
    mockUseRelay.mockImplementation((_t, opts) => {
      onEvent = (opts as { onEvent?: (e: unknown) => void } | undefined)
        ?.onEvent;
      return {
        client: client as never,
        relayState: "connected",
        relayTicket: {
          peerFingerprint: "fp-web",
          clientName: "Browser",
          accessToken: "t",
          expiresAt: Date.now() + 120_000,
        },
        relayTicketError: null,
        handshakeRejection: null,
        reconnect: vi.fn(),
      };
    });
    return render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionDetailView deviceId={1} conversationId="42" form="embedded" />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("名单读失败：顶部横幅（说原因 + 44px 重试），转录保留；重试成功后横幅消失", async () => {
    let failing = true;
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") {
        if (failing) throw new ApiUnavailableError(path, 502, "<html>");
        return { devices: [deviceRow] };
      }
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return { frames: [], cursor: 0, has_more: false };
      throw new Error("unexpected: " + path);
    });
    mount();

    const banner = await screen.findByTestId("session-roster-failure");
    expect(banner.textContent).toContain("(502)");
    // 转录与输入区都还在：横幅是加在上面的，不是换掉整页。
    expect(await screen.findByText("转录还在")).toBeTruthy();
    expect(screen.getByTestId("session-detail-scroll")).toBeTruthy();
    // 横幅在滚动区之外（不被转录上沿的渐隐遮挡）。
    expect(screen.getByTestId("session-detail-scroll").contains(banner)).toBe(
      false,
    );
    const retry = within(banner).getByRole("button", { name: "Retry" });
    expect(is44(retry)).toBe(true);

    failing = false;
    deviceRoster.invalidate();
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("session-roster-failure")).toBeNull(),
    );
    expect(screen.getByText("转录还在")).toBeTruthy();
  });

  it("名单读失败且是 401：横幅给「重新登录」", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") throw new ApiError(30004, "未登录", 401);
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return { frames: [], cursor: 0, has_more: false };
      throw new Error("unexpected: " + path);
    });
    mount();
    const banner = await screen.findByTestId("session-roster-failure");
    expect(
      within(banner).getByRole("link", { name: "Sign in again" }),
    ).toBeTruthy();
  });

  it("滚动区在带吸顶横幅时让渐隐退场（W32）", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path.startsWith("/v1/agent-sessions?"))
        return { total: 0, items: [] };
      if (path.startsWith("/v1/agent-sessions/transcript"))
        return { frames: [], cursor: 0, has_more: false };
      throw new Error("unexpected: " + path);
    });
    mount();
    const scroll = await screen.findByTestId("session-detail-scroll");
    expect(scroll.className).toContain("transcript-fade-top");
    expect(scroll.className).toContain(
      "has-[[data-session-status]]:[mask-image:none]",
    );
    expect(scroll.className).toContain(
      "has-[[data-session-status]]:[-webkit-mask-image:none]",
    );
  });
});
