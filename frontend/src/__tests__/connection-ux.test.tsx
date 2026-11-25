/**
 * 执行端连接的界面呈现（规格 2026-11-25 E1 / E4 / E5 去抖 / H5，对比稿 d2 B、v10 B）：
 *   - 连不上约 20 秒：页头「连不上 · 立即重试」+ 页头下「下次自动重试 N 秒后」；19 秒连上不出现。
 *   - 401（signedOut）：只给重新登录，永不出重试。
 *   - 读不到这条对话的清单：退避重问；重连后重问；补齐失败说出来；断线清掉流式尾巴。
 *   - 机器「不可达」去抖约 3 秒。
 *   - 手机页头离线只写「离线」；「网络不稳定」细条在页头下方。
 *
 * 假时钟 + 假中继（use-relay 的替身），与 session-detail 系列同一套接法。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type { RelayState } from "@/lib/relayClient";
import {
  useRelayChannel,
  type UseRelayChannelOptions,
} from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import SessionDetailView from "@/components/session/SessionDetailView";
import Chat from "@/pages/Chat";
import { useMachineReachability } from "@/pages/chat/useMachineReachability";
import type { DeviceItem } from "@/lib/devices";
import { resetLiveTurns } from "@/lib/liveSessions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));

// 身份状态由用例给：细条只在 unstable 时出现。
const identity = vi.hoisted(() => ({ status: "ready" as string }));
vi.mock("@/hooks/use-me", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-me")>();
  return {
    ...actual,
    useMe: () => ({
      me: {
        user_id: 1,
        email: "a@b.c",
        display_name: "A",
        avatar_url: "",
        github_login: "",
        csrf_token: "c",
      },
      status: identity.status,
      attempt: 0,
      inFlight: false,
      retry: () => {},
    }),
  };
});

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);

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
  latestSeq: 2,
};

const fakeClient = {
  request: vi.fn(),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async (_id?: string) => {}),
  setCursor: vi.fn(),
  getCursor: vi.fn(() => 0),
  close: vi.fn(),
};

let capturedOpts: UseRelayChannelOptions = {};
let relayState: RelayState = "connecting";
let nextRetryAt: number | null = null;
let rerenderTree: (() => void) | null = null;
const reconnect = vi.fn();

const originalMatchMedia = window.matchMedia;
function mockMobileViewport() {
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
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockReset();
  fakeClient.catchUp.mockImplementation(async () => {});
  fakeClient.getCursor.mockReturnValue(0);
  reconnect.mockReset();
  capturedOpts = {};
  relayState = "connecting";
  nextRetryAt = null;
  identity.status = "ready";
  resetLiveTurns();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

function stubApi(
  device: Record<string, unknown> = deviceRow,
  items: Record<string, unknown>[] = [],
) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path === "/v1/devices") return { devices: [device] };
    if (path === "/v1/workspace/agents") return { agents: [] };
    if (path.startsWith("/v1/agent-sessions?"))
      return { total: items.length, items };
    if (path.startsWith("/v1/agent-sessions/transcript"))
      return { frames: [], cursor: 0, has_more: false };
    if (path === "/v1/agent-sessions/read") return { last_read_at: 1 };
    throw new Error("unexpected: " + path);
  });
}

function stubClient(listImpl?: () => Promise<unknown>) {
  fakeClient.request.mockImplementation(async (method: unknown) => {
    if (method === rpcMethods.sessionList)
      return listImpl ? listImpl() : { sessions: [summary] };
    if (method === rpcMethods.sessionPendingWaiters)
      return { toolPermissions: [], askUserQuestions: [] };
    throw new Error("unexpected: " + String(method));
  });
}

function mountDetail(form?: "page") {
  mockUseRelay.mockImplementation((_fp, opts) => {
    capturedOpts = opts ?? {};
    return {
      client: relayState === "signedOut" ? null : (fakeClient as never),
      relayState,
      relayTicket: {
        peerFingerprint: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      handshakeRejection: null,
      nextRetryAt,
      reconnect,
    };
  });
  const tree = () => (
    <MemoryRouter initialEntries={["/chat/42"]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="/chat/42"
            element={
              <SessionDetailView deviceId={1} conversationId="42" form={form} />
            }
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>
  );
  const view = render(tree());
  rerenderTree = () => view.rerender(tree());
  return view;
}

async function moveRelayTo(next: RelayState) {
  relayState = next;
  await act(async () => {
    rerenderTree?.();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const RETRY_CHIP = /can.t connect · retry now/i;

describe("E1：约 20 秒连不上 → 页头「连不上 · 立即重试」+ 倒计时", () => {
  it("19 秒时连上了：从不出现；20 秒仍连不上：出现，点它立即重试", async () => {
    stubApi();
    stubClient();
    mountDetail();
    await advance(19_000);
    expect(screen.queryByRole("button", { name: RETRY_CHIP })).toBeNull();

    await advance(1_000);
    const chip = await screen.findByRole("button", { name: RETRY_CHIP });
    fireEvent.click(chip);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("19 秒连上后再断，重新从 0 计：不会沿用上一段的时间", async () => {
    stubApi();
    stubClient();
    mountDetail();
    await advance(19_000);
    await moveRelayTo("connected");
    await moveRelayTo("reconnecting");
    await advance(19_000);
    expect(screen.queryByRole("button", { name: RETRY_CHIP })).toBeNull();
  });

  it("页头下写「下次自动重试 N 秒后」，随时间递减；没排着重试时不写", async () => {
    stubApi();
    stubClient();
    nextRetryAt = Date.now() + 35_000;
    mountDetail();
    await advance(20_000);
    const strip = await screen.findByTestId("session-retry-countdown");
    expect(strip.textContent).toMatch(/15 s/);
    await advance(2_000);
    expect(screen.getByTestId("session-retry-countdown").textContent).toMatch(
      /13 s/,
    );
  });

  it("手机页头：状态字写「连不上」并带 44px 的「立即重试」", async () => {
    mockMobileViewport();
    stubApi();
    stubClient();
    mountDetail("page");
    await advance(20_000);
    const retry = await screen.findByRole("button", { name: /retry now/i });
    expect(retry.className).toContain("min-h-11");
    expect(screen.getByTestId("session-detail-status").textContent).toMatch(
      /can.t connect/i,
    );
  });

  it("401（signedOut）：只给重新登录，永远没有重试按钮", async () => {
    stubApi();
    stubClient();
    mountDetail();
    await moveRelayTo("signedOut");
    await advance(60_000);
    expect(screen.queryByRole("button", { name: RETRY_CHIP })).toBeNull();
    expect(screen.queryByTestId("session-retry-countdown")).toBeNull();
    const link = await screen.findByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe("/login");
  });
});

describe("E4：清单、补齐与流式尾巴", () => {
  it("读不到这条对话的清单：退避重问，答上来后失败提示收起", async () => {
    stubApi();
    let calls = 0;
    stubClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return { sessions: [summary] };
    });
    relayState = "connected";
    mountDetail();
    await screen.findByTestId("session-catchup-failed");
    expect(calls).toBe(1);
    await advance(30_000);
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(screen.queryByTestId("session-catchup-failed")).toBeNull(),
    );
  });

  it("清单一直失败：退避拉长，不是每秒一次", async () => {
    stubApi();
    let calls = 0;
    stubClient(async () => {
      calls += 1;
      throw new Error("timeout");
    });
    relayState = "connected";
    mountDetail();
    await screen.findByTestId("session-catchup-failed");
    // 逐秒推进：每次失败之后要让 React 先把「失败」渲染出来，下一次的 timer 才排得上。
    for (let i = 0; i < 60; i += 1) await advance(1_000);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(8);
  });

  it("重连之后重问清单", async () => {
    stubApi();
    let calls = 0;
    stubClient(async () => {
      calls += 1;
      return { sessions: [summary] };
    });
    relayState = "connected";
    mountDetail();
    await waitFor(() => expect(calls).toBe(1));
    await moveRelayTo("reconnecting");
    await moveRelayTo("connected");
    await waitFor(() => expect(calls).toBe(2));
  });

  it("重连后补齐失败：说出来，而不是让「在跑」永远挂着", async () => {
    stubApi();
    stubClient();
    relayState = "connected";
    mountDetail();
    await waitFor(() => expect(fakeClient.catchUp).toHaveBeenCalled());
    await advance(1_000);
    expect(screen.queryByTestId("session-catchup-failed")).toBeNull();

    fakeClient.catchUp.mockRejectedValue(new Error("boom"));
    await moveRelayTo("reconnecting");
    await moveRelayTo("connected");
    expect(await screen.findByTestId("session-catchup-failed")).toBeTruthy();
  });

  it("断线时清掉未完成的流式尾巴，新增量不接在旧半截后面", async () => {
    stubApi();
    stubClient();
    relayState = "connected";
    mountDetail();
    await waitFor(() => expect(fakeClient.catchUp).toHaveBeenCalled());
    await advance(500);
    act(() => {
      capturedOpts.onPreviewEvent?.(
        {
          conversationId: "42",
          event: { kind: "text_delta", text: "半截流式正文" },
        },
        Date.now(),
      );
    });
    expect(await screen.findByText(/半截流式正文/)).toBeTruthy();

    await moveRelayTo("reconnecting");
    expect(screen.queryByText(/半截流式正文/)).toBeNull();
  });
});

describe("H5：离线只留一处说明", () => {
  it("手机页头离线只写「Offline」，不带「N 分钟前」", async () => {
    mockMobileViewport();
    // 账号镜像里有这条对话的最后活动时间：此前页头会拿它写成「离线 · 3 分钟前」，
    // 与机器最后在线的时间对不上（F12）。
    stubApi({ ...deviceRow, online: false }, [
      {
        peer_fingerprint: "fp-1",
        conversation_id: "42",
        title: "重构登录页",
        last_message_at: Date.now() - 180_000,
      },
    ]);
    stubClient();
    mountDetail("page");
    const status = await screen.findByTestId("session-detail-status");
    await waitFor(() => expect(status.textContent).toMatch(/offline/i));
    expect(status.textContent).not.toMatch(/ago|·/i);
  });
});

describe("细条位置：对话页的「网络不稳定」落在页头之下", () => {
  it("手机沉浸页：细条紧跟在页头后面，且只有一条", async () => {
    mockMobileViewport();
    identity.status = "unstable";
    stubApi();
    stubClient();
    relayState = "connected";
    mountDetail("page");
    const header = await screen.findByTestId("session-detail-header");
    const strips = screen.getAllByTestId("identity-unstable");
    expect(strips).toHaveLength(1);
    expect(header.nextElementSibling).toBe(strips[0]);
  });
});

describe("E5：机器「不可达」去抖约 3 秒", () => {
  const machine: DeviceItem = {
    id: 7,
    name: "mac",
    kind: "agentred",
    fingerprint: "fp-7",
    status: 1,
    online: true,
    last_seen_at: 1,
  } as DeviceItem;

  function Probe({
    onStates,
  }: {
    onStates: (s: Record<number, string>) => void;
  }) {
    const reach = useMachineReachability({
      devices: [machine],
      axis: "machine",
      keyword: "",
      filter: "all",
    });
    onStates(reach.machineStates);
    return <>{reach.resolvers}</>;
  }

  function mountProbe() {
    let latest: Record<number, string> = {};
    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState,
      relayTicket: null,
      relayTicketError: null,
      handshakeRejection: null,
      reconnect,
    }));
    const tree = () => (
      <Probe
        onStates={(s) => {
          latest = s;
        }}
      />
    );
    const view = render(tree());
    return {
      states: () => latest,
      rerender: () => view.rerender(tree()),
    };
  }

  it("抖动短于 3 秒不报不可达；持续 3 秒才报；恢复立即撤销", async () => {
    stubClient();
    relayState = "connected";
    const probe = mountProbe();
    await advance(10);
    relayState = "reconnecting";
    await act(async () => probe.rerender());
    await advance(2_000);
    expect(probe.states()[7]).not.toBe("unreachable");
    relayState = "connected";
    await act(async () => probe.rerender());
    await advance(5_000);
    expect(probe.states()[7]).not.toBe("unreachable");

    relayState = "reconnecting";
    await act(async () => probe.rerender());
    await advance(3_100);
    expect(probe.states()[7]).toBe("unreachable");
    relayState = "connected";
    await act(async () => probe.rerender());
    await advance(10);
    expect(probe.states()[7]).not.toBe("unreachable");
  });
});

describe("E1：首页页头副行", () => {
  it("执行端连不上（去抖后）：副行写「执行端连不上」并保留机器在线数", async () => {
    mockMobileViewport();
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/agent-sessions?")) {
        const params = new URLSearchParams(path.split("?")[1] ?? "");
        if (params.get("per_group") === "1") return { total: 0 };
        return { total: 0, groups: [] };
      }
      if (path === "/v1/devices")
        return {
          devices: [
            deviceRow,
            { ...deviceRow, id: 2, fingerprint: "fp-2", online: false },
          ],
        };
      if (path === "/v1/workspace/agents") return { agents: [] };
      if (path === "/v1/workspace/projects") return { projects: [] };
      throw new Error("unexpected: " + path);
    });
    stubClient();
    relayState = "connected";
    mockUseRelay.mockImplementation(() => ({
      client: fakeClient as never,
      relayState,
      relayTicket: null,
      relayTicketError: null,
      handshakeRejection: null,
      reconnect,
    }));
    const tree = () => (
      <MemoryRouter initialEntries={["/chat?axis=machine"]}>
        <ThemeProvider>
          <Routes>
            <Route path="/chat/:conversationId?" element={<Chat />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>
    );
    const view = render(tree());
    const subtitle = await screen.findByTestId("chat-phone-subtitle");
    await waitFor(() => expect(subtitle.textContent).toContain("1 / 2"));
    expect(subtitle.textContent).not.toMatch(/unreachable/i);

    relayState = "reconnecting";
    await act(async () => view.rerender(tree()));
    await advance(2_000);
    expect(screen.getByTestId("chat-phone-subtitle").textContent).not.toMatch(
      /unreachable/i,
    );
    await advance(1_500);
    expect(screen.getByTestId("chat-phone-subtitle").textContent).toBe(
      "Execution side unreachable · 1 / 2 machines online",
    );
  });
});
