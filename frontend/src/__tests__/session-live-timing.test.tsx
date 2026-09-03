/**
 * 一轮在跑的时候，那条 meta 上的计时（本页的接线）。
 *
 * 画这一格的是共享包的 `MessageMeta`，两端同一份组件；它靠 `liveTurn` 才开表
 * （`transcript-row-view` 里 `useNow(liveTurn != null)` 那条 200ms 心跳）。桌面端
 * 从 `chat-streams-store` 上摘出这份计时交给它，本站此前一样都不交 —— 于是耗时
 * 只有终态帧 `durationMs` 一条来路，**一轮跑完才出数**，跑的过程里那一格是死的。
 *
 * 这一组从页面进：轮次由中继的实时信号开起来，时钟由 `Date` 推进，断言的是用户
 * 真的看得见的那几个数。
 */
import { act, render, screen } from "@testing-library/react";
import { rpcMethods, SessionLifecycleRunning } from "@agentre-hub/agentre-wire";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import {
  useRelayMachine,
  type UseRelayMachineOptions,
} from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import SessionDetail from "@/pages/SessionDetail";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/hooks/use-relay", () => ({ useRelayMachine: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayMachine);

/** 冻住的起点。只假 `Date`，定时器保持真的 —— 心跳还是那 200ms 一跳。 */
const T0 = 1_756_000_000_000;

const deviceRow = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: T0,
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

let capturedOpts: UseRelayMachineOptions = {};

const fakeClient = {
  request: vi.fn(),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  setCursor: vi.fn(),
  getCursor: vi.fn(() => 0),
  close: vi.fn(),
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  capturedOpts = {};
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockReset();
  fakeClient.getCursor.mockReturnValue(0);
  fakeClient.attach.mockImplementation(async () => ({}));
});

afterEach(() => {
  vi.useRealTimers();
});

/** 清单里这一条的生命周期状态 —— 「接进来时对端已经在跑」由它决定。 */
function stubSession(lifecycleState: string) {
  mockedApi.mockImplementation(async (path) => {
    if (path === "/v1/devices") return { devices: [deviceRow] };
    throw new Error("unexpected: " + path);
  });
  fakeClient.request.mockImplementation(async (method) => {
    if (method === rpcMethods.sessionList)
      return { sessions: [{ ...summary, lifecycleState }] };
    if (method === rpcMethods.sessionPendingWaiters)
      return { toolPermissions: [], askUserQuestions: [] };
    throw new Error("unexpected: " + method);
  });
  fakeClient.catchUp.mockImplementation(async () => {
    capturedOpts.onEvent?.({
      conversationId: "42",
      event: { kind: "text_delta", text: "你好" },
      seq: 1,
    });
  });
}

function renderPage(navState?: Record<string, unknown>) {
  mockUseRelay.mockImplementation((_target, opts) => {
    capturedOpts = opts ?? {};
    return {
      client: fakeClient as never,
      relayState: "connected",
      relayTicket: {
        clientId: "fp-web",
        clientName: "Browser",
        accessToken: "t",
        expiresAt: Date.now() + 120_000,
      },
      relayTicketError: null,
      reconnect: vi.fn(),
    };
  });
  return render(
    <MemoryRouter
      initialEntries={[
        { pathname: "/devices/1/sessions/42", state: navState ?? null },
      ]}
    >
      <ThemeProvider>
        <Routes>
          <Route
            path="/devices/:deviceId/sessions/:conversationId"
            element={<SessionDetail />}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function emit(event: Record<string, unknown>, seq: number) {
  act(() => {
    capturedOpts.onEvent?.({ conversationId: "42", event, seq });
  });
}

describe("一轮在跑时的计时", () => {
  /**
   * 首帧还没回来的那一段：能说的只有「已经等了多久」，而它必须自己走。
   * 桌面端此刻画的正是这一个数（`waitingFirstToken` 那一支）。
   */
  it("给定这个浏览器开起了一轮，当时间走过 3 秒，则等待时长跟着走", async () => {
    stubSession("idle");
    renderPage();
    await screen.findByText("你好", undefined, { timeout: 3_000 });

    act(() => {
      capturedOpts.onAutonomousTurnStarted?.({
        conversationId: "42",
      } as never);
    });
    vi.setSystemTime(T0 + 3_000);

    expect(
      await screen.findByText("3.0s", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
  });

  /**
   * 首帧回来之后两个数分家：首字延迟就此定住，耗时继续走。这是「耗时那一格是活的」
   * 与「首字那一格是死的」同时成立 —— 只画一个数看不出来。
   */
  it("给定首帧已到，当时间继续走，则首字定住而耗时继续走", async () => {
    stubSession("idle");
    renderPage();
    await screen.findByText("你好", undefined, { timeout: 3_000 });

    act(() => {
      capturedOpts.onAutonomousTurnStarted?.({
        conversationId: "42",
      } as never);
    });
    vi.setSystemTime(T0 + 3_000);
    emit({ kind: "text_delta", text: "在写了" }, 2);
    vi.setSystemTime(T0 + 9_000);

    expect(
      await screen.findByText("9.0s", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(screen.getByTestId("message-first-token").textContent).toContain(
      "3.0s",
    );
  });

  /**
   * 接进来时对端已经在跑：这一轮什么时候开的，本站**不知道** —— wire 上带
   * `started_at` 的只有会话级与导入用的结构，跑着的那一轮没有。从接进来那一刻起表
   * 会给出一个偏小的数，而它看着与真的一样；这一格宁可不画。
   */
  it("给定接进来时对端已经在跑，当时间走过 3 秒，则不从接入那一刻编出计时", async () => {
    stubSession(SessionLifecycleRunning);
    renderPage();
    await screen.findByText("你好", undefined, { timeout: 3_000 });

    vi.setSystemTime(T0 + 3_000);
    emit({ kind: "text_delta", text: "在写了" }, 2);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("3.0s")).toBeNull();
    expect(screen.queryByTestId("message-first-token")).toBeNull();
  });

  /**
   * 终态帧到了就以它为准：agentred 那一份是就着自己扇出的事件流量的（口径与桌面端
   * 共用 `turnstats`），比浏览器这边隔着一条中继数出来的准。此刻表必须收 —— 继续
   * 自己走的话，一轮结束之后那个数还会一直涨。
   */
  it("给定终态帧带了耗时，当时间继续走，则以终态帧那一份为准", async () => {
    stubSession("idle");
    renderPage();
    await screen.findByText("你好", undefined, { timeout: 3_000 });

    act(() => {
      capturedOpts.onAutonomousTurnStarted?.({
        conversationId: "42",
      } as never);
    });
    emit({ kind: "text_delta", text: "在写了" }, 2);
    act(() => {
      capturedOpts.onRunResultDone?.({
        conversationId: "42",
        durationMs: 9_640,
      } as never);
    });
    vi.setSystemTime(T0 + 60_000);

    expect(
      await screen.findByText("9.6s", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(screen.queryByText("1m 0s")).toBeNull();
  });
  /**
   * 从草稿页下钻过来的那一条：`runtime.run` 是**这个浏览器**几百毫秒前派发的，
   * 接进来时对端当然已经在跑。这一轮什么时候开的这里知道 —— 派发那一刻随导航
   * 交过来了，不必因为「接进来时已经在跑」就把它一起判成不可知。
   */
  it("给定刚从草稿页派发过来，当接进来时对端在跑，则耗时从派发那一刻起算", async () => {
    stubSession(SessionLifecycleRunning);
    renderPage({ turnStartedAt: T0 - 2_000 });
    await screen.findByText("你好", undefined, { timeout: 3_000 });

    vi.setSystemTime(T0 + 3_000);

    expect(
      await screen.findByText("5.0s", undefined, { timeout: 3_000 }),
    ).toBeTruthy();
  });

  /**
   * 同一份导航 state 会跟着那条历史记录一直留着：十分钟后刷新页面，它还在手上，
   * 而此刻在跑的多半已经是后面某一轮了。隔了这么久才装载，这个时刻只能是过期的
   * —— 拿它开表会画出一个「已经跑了 10 分钟」，比不画更糟。
   */
  it("给定派发时刻已经过期，当装载，则不拿它开表", async () => {
    stubSession(SessionLifecycleRunning);
    renderPage({ turnStartedAt: T0 - 10 * 60_000 });
    await screen.findByText("你好", undefined, { timeout: 3_000 });

    vi.setSystemTime(T0 + 3_000);
    emit({ kind: "text_delta", text: "在写了" }, 2);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("message-first-token")).toBeNull();
  });
});
