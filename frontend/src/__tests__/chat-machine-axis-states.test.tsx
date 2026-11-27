/**
 * 「按机器」轴的空白与加载态（规格 2026-11-25 A1 例外，任务 33）：这一轴不落本地，
 * 所以数据到达之前只能是骨架；离线 / 失败时说原因给重试；没有机器 / 没有对话各有空态。
 * 手机（390 宽）与桌面同一套判据。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";
import { rpcMethods } from "@agentre-hub/agentre-wire";

import { useRelayChannel, type UseRelayChannelResult } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { api, ApiError } from "@/lib/api";
import { bindAccount } from "@/lib/localStore";
import Chat from "@/pages/Chat";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));
vi.mock("@/components/session/SessionDetailView", () => ({
  default: () => <div data-testid="mobile-session-detail" />,
}));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);
const g = globalThis as Record<string, unknown>;
const originalMatchMedia = window.matchMedia;

function mockViewport(mobile: boolean) {
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

const machine = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
};
const offlineMachine = {
  ...machine,
  id: 2,
  fingerprint: "fp-2",
  online: false,
};
const agents = [
  {
    sync_id: "ag-1",
    name: "后端 Agent",
    avatar_color: "#4f46e5",
    has_available_target: true,
    exec_targets: [],
  },
];
const mirrored = {
  peer_fingerprint: "fp-1",
  device_fingerprint: "fp-1",
  conversation_id: "42",
  title: "时间轴上的旧行",
  agent_sync_id: "ag-1",
  backend_type: "claudecode",
  lifecycle_state: "idle",
  last_message_at: 1754800000000,
};

const onMachineOnly = {
  conversationId: "77",
  title: "机器上才有的",
  agentSyncId: "ag-1",
  cwd: "/home/agent/proj",
  backendType: "claudecode",
  lifecycleState: "idle",
  latestSeq: 1,
};

const fakeClient = {
  request: vi.fn(async (method: unknown) => {
    if (method === rpcMethods.sessionList) return { sessions: [onMachineOnly] };
    throw new Error("unexpected method: " + method);
  }),
  attach: vi.fn(async () => ({})),
  catchUp: vi.fn(async () => {}),
  close: vi.fn(),
};
function connectedRelay(): UseRelayChannelResult {
  return {
    client: fakeClient as never,
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
}

type Behaviour = {
  devices?: unknown[];
  /** 机器轴的索引请求怎么答。 */
  machineIndex?: () => Promise<unknown>;
  timeRows?: unknown[];
};
function stub(b: Behaviour = {}) {
  mockedApi.mockImplementation(async (path) => {
    if (path.startsWith("/v1/agent-sessions?")) {
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      if (params.get("axis") === "machine" && b.machineIndex) {
        return b.machineIndex();
      }
      const rows = (b.timeRows ?? []) as unknown[];
      if (params.get("per_group") === "1") return { total: rows.length };
      return {
        total: rows.length,
        groups: rows.length
          ? [{ scope: "time", total: rows.length, items: rows }]
          : [],
      };
    }
    if (path === "/v1/devices") return { devices: b.devices ?? [machine] };
    if (path === "/v1/workspace/agents") return { agents };
    if (path === "/v1/workspace/projects") return { projects: [] };
    throw new Error("unexpected: " + path);
  });
}
const never = () => new Promise<never>(() => {});

function Goto() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/chat?axis=machine")}>
        goto machine
      </button>
      <button type="button" onClick={() => navigate("/chat")}>
        goto time
      </button>
    </>
  );
}

function renderChat(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ThemeProvider>
        <Goto />
        <Routes>
          <Route path="/chat/:conversationId?" element={<Chat />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = IDBKeyRange;
  bindAccount(1);
  await i18n.changeLanguage("en");
  mockViewport(true);
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  mockUseRelay.mockReturnValue(connectedRelay());
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

const skeleton = () =>
  document.querySelector('[data-slot="session-row-skeleton"]');

describe.each([
  ["手机", true],
  ["桌面", false],
])("按机器轴（%s）", (_name, mobile) => {
  beforeEach(() => mockViewport(mobile));

  it("冷启动：数据到达前是骨架，不是「没有对话」", async () => {
    stub({ machineIndex: never });
    renderChat("/chat?axis=machine");
    await waitFor(() => expect(skeleton()).not.toBeNull());
    expect(screen.queryByText("No conversations yet.")).toBeNull();
    expect(screen.queryByTestId("chat-empty-state")).toBeNull();
  });

  it("从别的轴切来、机器轴数据未到：骨架，且不显示上一轴的行", async () => {
    stub({ machineIndex: never, timeRows: [mirrored] });
    renderChat("/chat");
    expect(await screen.findByText("时间轴上的旧行")).toBeTruthy();
    fireEvent.click(screen.getByText("goto machine"));
    await waitFor(() => expect(skeleton()).not.toBeNull());
    expect(screen.queryByText("时间轴上的旧行")).toBeNull();
    expect(screen.queryByText("No conversations yet.")).toBeNull();
  });

  it("机器轴看过一次，离开再回来、数据未到：骨架，不显示上次的行", async () => {
    let answers = 0;
    stub({
      timeRows: [mirrored],
      machineIndex: () =>
        ++answers === 1
          ? Promise.resolve({
              total: 1,
              groups: [{ scope: "machine:fp-1", total: 1, items: [mirrored] }],
            })
          : never(),
    });
    renderChat("/chat?axis=machine");
    expect(await screen.findByText("机器上才有的")).toBeTruthy();
    fireEvent.click(screen.getByText("goto time"));
    await waitFor(() => expect(answers).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("goto machine"));
    await waitFor(() => expect(answers).toBeGreaterThan(1));
    await waitFor(() => expect(skeleton()).not.toBeNull());
    expect(screen.queryByText("机器上才有的")).toBeNull();
  });
});

describe("手机：机器轴失败与空态", () => {
  it("断网且没拿到数据：说原因、给 44px 重试", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    stub({
      machineIndex: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderChat("/chat?axis=machine");
    const failed = await screen.findByTestId("chat-load-failed");
    expect(failed.textContent).toContain("network seems to be down");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("h-11");
  });

  it("服务失败：说服务不可用并给重试", async () => {
    stub({
      machineIndex: async () => {
        throw new ApiError(500, "boom", 500);
      },
    });
    renderChat("/chat?axis=machine");
    expect(await screen.findByTestId("chat-load-failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("401：出口是重新登录", async () => {
    stub({
      machineIndex: async () => {
        throw new ApiError(401, "x", 401);
      },
    });
    renderChat("/chat?axis=machine");
    const failed = await screen.findByTestId("chat-load-failed");
    expect(failed.querySelector('a[href^="/login"]')?.textContent).toContain(
      "Sign in again",
    );
  });

  it("没有配对的机器：引导去 /devices", async () => {
    stub({
      devices: [],
      machineIndex: async () => ({ total: 0, groups: [] }),
    });
    renderChat("/chat?axis=machine");
    const empty = await screen.findByTestId("chat-empty-state");
    const link = empty.querySelector('a[href="/devices"]');
    expect(link).not.toBeNull();
  });

  it("有机器、没有对话：给开始对话的空态", async () => {
    fakeClient.request.mockResolvedValue({ sessions: [] } as never);
    stub({
      devices: [machine],
      machineIndex: async () => ({ total: 0, groups: [] }),
    });
    renderChat("/chat?axis=machine");
    const empty = await screen.findByTestId("chat-empty-state");
    expect(empty.textContent).toContain("No conversations yet.");
    expect(skeleton()).toBeNull();
  });

  it("只有离线的机器、没有对话：不卡在骨架", async () => {
    stub({
      devices: [offlineMachine],
      machineIndex: async () => ({ total: 0, groups: [] }),
    });
    renderChat("/chat?axis=machine");
    await screen.findByTestId("chat-empty-state");
    expect(skeleton()).toBeNull();
  });
});

describe("桌面：机器轴失败与空态", () => {
  beforeEach(() => mockViewport(false));

  it("断网且没拿到数据：说原因并给重试，不是「没有对话」", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    stub({
      machineIndex: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderChat("/chat?axis=machine");
    const banner = await screen.findByTestId("index-load-error");
    expect(banner.textContent).toContain("network seems to be down");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No conversations yet.")).toBeNull();
  });

  it("没有配对的机器：空态引导去 /devices", async () => {
    stub({
      devices: [],
      machineIndex: async () => ({ total: 0, groups: [] }),
    });
    renderChat("/chat?axis=machine");
    const empty = await screen.findByTestId("chat-empty-state");
    expect(empty.querySelector('a[href="/devices"]')).not.toBeNull();
  });
});
