/**
 * 草稿交接之后发起页收不到实时帧：通道层的复现。
 *
 * 与 draft-handover-live-card.test.tsx 的差别：这里不 mock useRelayChannel，而是在
 * relayClientPool 这一层放一个按**通道**投递的替身 —— 只有在这条通道上 attach 过这条
 * 会话的那条通道收得到它的实时帧（agentred connRegistry.subs 的语义：订阅按连接记）。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { rpcMethods, SessionLifecycleRunning } from "@agentre-hub/agentre-wire";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { dispatchNewConversation, fetchDispatchPlan } from "@/lib/dispatch";
import { ensureRelayTicket } from "@/lib/relayTicket";
import type { RelayListener } from "@/lib/relayClientPool";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import Chat from "@/pages/Chat";

type Channel = {
  target: string;
  listeners: Set<RelayListener>;
  attached: Set<string>;
  /** 这条通道上的客户端按会话记的游标（RelayClient 的独占游标：已交付的最后 seq）。 */
  cursors: Map<string, number>;
  client: ReturnType<typeof makeClient>;
};
const channels = new Map<string, Channel>();
const log: string[] = [];
/**
 * daemon 那一侧这条会话的帧账本：实时帧扇出之前先落在这里，补齐（pull）从这里读
 * 游标之后的那一段。
 */
const daemonFrames: { event: Record<string, unknown>; seq: number }[] = [];
const latestSeq = () => daemonFrames.at(-1)?.seq ?? 1;

/** 补齐：把账本里游标之后的那一段按序交给这条通道的监听者（拉取页 seq > 游标即消费）。 */
function pull(ch: Channel, sid: string) {
  for (const f of daemonFrames) {
    if (f.seq <= (ch.cursors.get(sid) ?? 0)) continue;
    ch.cursors.set(sid, f.seq);
    for (const l of ch.listeners)
      l.onEvent?.({ conversationId: sid, event: f.event, seq: f.seq } as never);
  }
}

function makeClient(target: string) {
  const ch = () => channels.get(target)!;
  return {
    request: vi.fn(async (method: unknown) => {
      if (method === rpcMethods.sessionList)
        return {
          sessions: [
            {
              conversationId: "99",
              peerFingerprint: "fp-web",
              title: "run perl",
              agentSyncId: "agent-1",
              backendType: "claudecode",
              lifecycleState: SessionLifecycleRunning,
              latestSeq: latestSeq(),
            },
          ],
        };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      return {};
    }),
    attach: vi.fn(async (sid: string) => {
      log.push(`attach ${sid} on ${target}`);
      ch().attached.add(sid);
      return { latestSeq: latestSeq() };
    }),
    catchUp: vi.fn(async (sid: string) => pull(ch(), sid)),
    setCursor: vi.fn((sid: string, seq: number) => ch().cursors.set(sid, seq)),
    getCursor: vi.fn((sid: string) => ch().cursors.get(sid) ?? 0),
    close: vi.fn(),
    state: "connected",
  };
}

function channel(target: string): Channel {
  let ch = channels.get(target);
  if (!ch) {
    ch = {
      target,
      listeners: new Set(),
      attached: new Set(),
      cursors: new Map(),
      client: makeClient(target),
    };
    channels.set(target, ch);
  }
  return ch;
}

/** 某条通道被借出之前那一刻：交给用例在「旧通道已还、新通道还没 attach」之间插帧。 */
let beforeAcquire: (target: string) => void = () => {};

const ticket = {
  peerFingerprint: "fp-web",
  clientName: "Chrome · macOS",
  accessToken: "web-jwt",
  expiresAt: Date.now() + 120_000,
};

vi.mock("@/lib/relayClientPool", () => ({
  acquireRelayClient: vi.fn(
    async (target: string, listener?: RelayListener) => {
      beforeAcquire(target);
      const ch = channel(target);
      if (listener) ch.listeners.add(listener);
      log.push(`acquire ${target}`);
      queueMicrotask(() => listener?.onStateChange?.("connected"));
      return {
        client: ch.client,
        ticket,
        release: () => {
          if (listener) ch.listeners.delete(listener);
          log.push(`release ${target}`);
        },
      };
    },
  ),
  withRelayClient: vi.fn(async (target: string, fn: (c: unknown) => unknown) =>
    fn(channel(target).client),
  ),
  relayClientPool: { reconnect: vi.fn(async () => true) },
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch")>();
  return {
    ...actual,
    fetchDispatchPlan: vi.fn(),
    dispatchNewConversation: vi.fn(),
  };
});
vi.mock("@/lib/relayTicket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayTicket")>();
  return { ...actual, ensureRelayTicket: vi.fn() };
});
vi.mock("@/lib/cliModels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cliModels")>();
  return { ...actual, listCLIModelsOn: vi.fn(async () => []) };
});
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const agents = [
  {
    sync_id: "agent-1",
    name: "Backend Agent",
    avatar_color: "agent-1",
    project_sync_ids: [],
    has_available_target: true,
    exec_targets: [
      {
        rank: 1,
        device_name: "Study Mini",
        availability: "available",
        current: true,
      },
    ],
  },
];

const plan = {
  agent_sync_id: "agent-1",
  tiers: [
    {
      rank: 1,
      backend_sync_id: "b-a",
      device_id: 20,
      device_name: "Study Mini",
      backend_type: "claudecode",
      kind: "agentred",
      availability: "available",
      current: true,
    },
  ],
  chosen: {
    device_fingerprint: "fp-a",
    device_id: 20,
    device_name: "Study Mini",
    backend_type: "claudecode",
    kind: "agentred",
  },
  projects: [],
};

const row = {
  peer_fingerprint: "fp-web",
  device_fingerprint: "fp-a",
  conversation_id: "99",
  title: "run perl",
  agent_sync_id: "agent-1",
  backend_type: "claudecode",
  lifecycle_state: "running",
  last_message_at: 1793936013000,
};

/** 账号镜像那一行什么时候看得见：真实环境里它比派发晚几百毫秒才落库。 */
let rowVisible = false;
/** 派发之后那次重取索引：交给用例决定它什么时候回来。 */
let dispatched = false;
let openIndex: () => void = () => {};
let indexGate: Promise<void> = Promise.resolve();

/**
 * daemon 扇出一帧：先落账本，再只投给在**自己这条通道上** attach 过这条会话的那些
 * 通道。通道没有监听者时（还给池子、还在空闲宽限里）客户端照样消费、游标照样往前走
 * —— 与 RelayClient 一样；跳号时不投递，改从游标补齐。
 */
function emit(event: Record<string, unknown>, seq: number) {
  daemonFrames.push({ event, seq });
  for (const ch of channels.values()) {
    if (!ch.attached.has("99")) continue;
    const cursor = ch.cursors.get("99") ?? 0;
    if (seq <= cursor) continue;
    if (seq > cursor + 1) {
      pull(ch, "99");
      continue;
    }
    ch.cursors.set("99", seq);
    for (const l of ch.listeners)
      l.onEvent?.({ conversationId: "99", event, seq } as never);
  }
}

function pushEvent(event: Record<string, unknown>, seq: number) {
  act(() => emit(event, seq));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  channels.clear();
  log.length = 0;
  daemonFrames.length = 0;
  beforeAcquire = () => {};
  rowVisible = false;
  dispatched = false;
  indexGate = new Promise((r) => (openIndex = r));
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/agent-sessions?conversation_id="))
      return { items: rowVisible ? [row] : [] };
    if (path.startsWith("/v1/agent-sessions?") && dispatched) {
      await indexGate;
      return { total: 1, groups: [{ scope: "time", total: 1, items: [row] }] };
    }
    if (path.startsWith("/v1/agent-sessions?"))
      return rowVisible
        ? { total: 1, groups: [{ scope: "time", total: 1, items: [row] }] }
        : { total: 0, groups: [] };
    if (path.startsWith("/v1/agent-sessions/transcript"))
      return { frames: [], cursor: 0, oldest_seq: 0, has_before: false };
    if (path.startsWith("/v1/agent-sessions/read")) return { last_read_at: 1 };
    if (path === "/v1/devices")
      return {
        devices: [
          {
            id: 20,
            name: "Study Mini",
            kind: "agentred",
            fingerprint: "fp-a",
            online: true,
            status: 1,
          },
        ],
      };
    if (path.startsWith("/v1/workspace/agents")) return { agents };
    if (path.startsWith("/v1/workspace/projects")) return { projects: [] };
    throw new Error("unexpected: " + path);
  });
  vi.mocked(fetchDispatchPlan).mockResolvedValue(plan as never);
  vi.mocked(ensureRelayTicket).mockResolvedValue(ticket);
  vi.mocked(dispatchNewConversation).mockImplementation(async () => {
    dispatched = true;
    return {
      conversationId: "99",
      deviceId: 20,
      deviceFingerprint: "fp-a",
      peerFingerprint: "fp-web",
      title: "run perl",
      userText: "run perl",
      modelPinned: true,
      reasoningEffortPinned: true,
      savedToAccount: true,
    } as never;
  });
});

async function sendFromDraft() {
  render(
    <MemoryRouter initialEntries={["/chat?compose=1"]}>
      <ThemeProvider>
        <Routes>
          <Route path="/chat/:conversationId?" element={<Chat />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTestId("agent-pick-agent-1"));
  await screen.findByTestId("draft-session");
  await waitFor(() => {
    if (
      !document.querySelector(
        '[data-testid="session-detail-composer"] .ProseMirror',
      )
    )
      throw new Error("no composer");
  });
  const editable = document.querySelector<
    HTMLElement & {
      editor?: { commands: { setContent: (v: string) => void } };
    }
  >('[data-testid="session-detail-composer"] .ProseMirror')!;
  editable.editor?.commands.setContent("<p>run perl</p>");
  const send = screen.getByTestId("session-detail-send");
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  fireEvent.click(send);
  await screen.findByTestId("session-detail-view");
}

async function pushToolTurnAndExpectCard(firstSeq = 2) {
  pushEvent(
    {
      kind: "tool_use_start",
      id: "call_1",
      name: "Bash",
      input: { command: "perl -e 'sleep 20'" },
    },
    firstSeq,
  );
  pushEvent(
    {
      kind: "tool_permission_request",
      requestId: "tp-1",
      toolName: "Bash",
      input: { command: "perl -e 'sleep 20'" },
    },
    firstSeq + 1,
  );
  const scroll = await screen.findByTestId("session-detail-scroll");
  await waitFor(
    () =>
      expect(
        within(scroll).getAllByTestId("tool-permission-card").length,
      ).toBeGreaterThan(0),
    { timeout: 3_000 },
  );
}

describe("草稿交接之后的实时帧（按通道投递）", () => {
  it("Given 账号那一行在交接时已经看得见, Then 审批卡实时出现", async () => {
    rowVisible = true;
    openIndex();
    await sendFromDraft();
    await waitFor(() =>
      expect(log.some((l) => l.startsWith("attach 99"))).toBe(true),
    );
    await pushToolTurnAndExpectCard();
  });

  it("Given 账号那一行在 attach 之后才看得见, Then 换到按对话寻址的通道上重新 attach，换道那一刻的帧不丢不重，审批卡仍实时出现", async () => {
    rowVisible = false;
    await sendFromDraft();
    await waitFor(() =>
      expect(log.some((l) => l.startsWith("attach 99"))).toBe(true),
    );
    // 换道那一刻（机器通道已经还回池子、对话通道还没 attach）daemon 正好吐出一帧：
    // 它只落到还在空闲宽限里的机器通道上（那边没有监听者，游标却照样往前走）。
    beforeAcquire = (target) => {
      if (target === "conversation:99")
        emit({ kind: "text_delta", text: "换道那一刻的话" }, 2);
    };
    // 账号那一行落库了；左栏下一次取索引就会列出它（真实环境里是账号通道的推送）。
    rowVisible = true;
    // 派发之后那次重取索引此刻才回来：左栏列出这一行，右栏的种子换成这一行。
    await act(async () => {
      openIndex();
      await new Promise((r) => setTimeout(r, 300));
    });
    // attach 打在机器通道上；账号那一行落地后通道目标换成按对话寻址，旧通道被还掉，
    // 新通道上要再 attach 一次 —— daemon 只给 attach 过的通道扇出实时帧。
    expect(log).toEqual([
      "acquire machine:fp-a",
      "release machine:fp-a",
      "acquire machine:fp-a",
      "attach 99 on machine:fp-a",
      "release machine:fp-a",
      "acquire conversation:99",
      "attach 99 on conversation:99",
    ]);
    // 换道那一刻的帧由新通道的补齐交回来：在下一条实时帧到来之前就在，而且只有一份。
    const scroll = await screen.findByTestId("session-detail-scroll");
    await waitFor(() =>
      expect(within(scroll).getAllByText("换道那一刻的话")).toHaveLength(1),
    );
    await pushToolTurnAndExpectCard(3);
    expect(within(scroll).getAllByText("换道那一刻的话")).toHaveLength(1);
  });
});
