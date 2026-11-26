/**
 * 排队与失败的消息跟着对话保存（规格 2026-11-25 决策 C2、C3、C4、H8；审计 I1）。
 *
 *   - 排着的那一条离开对话、重载之后仍在，连上只发一次；
 *   - 一旦真的交给中继（「已交出」），App 在拿到结果前被杀，恢复后落「可能已送达」，
 *     永不自动再发；另一个标签页还在发的那条不被当成被杀；
 *   - 失败气泡离开、重载后仍在，与发送中同侧；
 *   - 两个实例（标签页）对着同一条排队消息，只有一个发得出去；
 *   - 「撤销」把整条消息（字与图，原样）放回输入框；
 *   - 大图发送显示「已传 / 共」，等应答的上限按体积放宽；
 *   - 手机首页行：「待发送：首行」优先于「[草稿]」。
 *
 * 页面走真的 SessionDetailView（中继 hook 换成替身），IndexedDB 用 fake-indexeddb：
 * 「重载」就是同一份库上再挂一次页面，「被杀」就是丢下在飞的请求、放掉它持有的锁。
 */
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { useRelayChannel } from "@/hooks/use-relay";
import i18n from "@/i18n";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import SessionDetailView from "@/components/session/SessionDetailView";
import { PhoneChatIndex } from "@/pages/chat/PhoneChatIndex";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import { draftStore } from "@/lib/drafts";
import { bindAccount, wipeBusinessData } from "@/lib/localStore";
import {
  outboxStore,
  requestTimeoutFor,
  useOutboxMap,
  type OutboxEntry,
} from "@/lib/outbox";
import { RelayError, RequestTimeoutMs } from "@/lib/relayClient";
import { encodeUserBlocks } from "@/lib/userBlocks";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));

const mockedApi = vi.mocked(api);
const mockUseRelay = vi.mocked(useRelayChannel);
const g = globalThis as Record<string, unknown>;
const originalMatchMedia = window.matchMedia;

const CID = "11111111-1111-7111-8111-111111111111";

/** 一张 1×3 字节的假 png。 */
const shot = {
  dataUrl: "data:image/png;base64,AQID",
  mediaType: "image/png",
  name: "shot.png",
};

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
  conversationId: CID,
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
  catchUp: vi.fn(async () => {}),
  setCursor: vi.fn(),
  getCursor: vi.fn(() => 0),
  close: vi.fn(),
};

/**
 * 跨标签页的 Web Locks 替身（整个源共用一份，与浏览器一致）。`crash()` 等于持有锁的
 * 标签页被杀：它持有的锁全部放掉，而它在飞的回调永远不会回来。
 */
class FakeLocks {
  private held = new Set<string>();
  private wake = new Map<string, Array<() => void>>();
  private releases = new Set<() => void>();

  async request(
    name: string,
    a: { ifAvailable?: boolean } | ((lock: unknown) => unknown),
    b?: (lock: unknown) => unknown,
  ): Promise<unknown> {
    const opts = typeof a === "function" ? {} : a;
    const cb = (typeof a === "function" ? a : b)!;
    if (opts.ifAvailable && this.held.has(name)) return cb(null);
    while (this.held.has(name)) {
      await new Promise<void>((r) => {
        const list = this.wake.get(name) ?? [];
        list.push(r);
        this.wake.set(name, list);
      });
    }
    this.held.add(name);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.held.delete(name);
      this.releases.delete(release);
      const waiters = this.wake.get(name) ?? [];
      this.wake.delete(name);
      for (const w of waiters) w();
    };
    this.releases.add(release);
    try {
      return await cb({ name, mode: "exclusive" });
    } finally {
      release();
    }
  }

  crash(): void {
    for (const release of [...this.releases]) release();
  }
}

function installLocks(): FakeLocks {
  const locks = new FakeLocks();
  Object.defineProperty(navigator, "locks", {
    value: locks,
    configurable: true,
  });
  return locks;
}

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

let relayState: "connected" | "reconnecting" = "connected";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = IDBKeyRange;
  bindAccount(1);
  mockMobileViewport();
  relayState = "connected";
  mockedApi.mockReset();
  mockUseRelay.mockReset();
  fakeClient.request.mockReset();
  fakeClient.attach.mockClear();
  fakeClient.catchUp.mockClear();
  mockedApi.mockImplementation(async (path) => {
    if (path === "/v1/devices") return { devices: [deviceRow] };
    if (path === "/v1/agent-sessions") return { items: [] };
    if (
      typeof path === "string" &&
      path.startsWith("/v1/agent-sessions/transcript")
    )
      return { frames: [], cursor: 0, has_more: false };
    throw new Error("unexpected: " + path);
  });
  mockUseRelay.mockImplementation(() => ({
    client: fakeClient as never,
    relayState,
    relayTicket: {
      peerFingerprint: "fp-web",
      clientName: "Browser",
      accessToken: "t",
      expiresAt: Date.now() + 120_000,
    },
    relayTicketError: null,
    handshakeRejection: null,
    reconnect: vi.fn(),
  }));
});

afterEach(() => {
  bindAccount(null);
  delete g.indexedDB;
  delete (navigator as unknown as Record<string, unknown>).locks;
  window.matchMedia = originalMatchMedia;
});

/** runtime.run 怎么答由用例给；其余照常。 */
function stubRun(
  onRun: (params: Record<string, unknown>, opts?: unknown) => unknown,
) {
  fakeClient.request.mockImplementation(
    async (method: unknown, params: unknown, opts: unknown) => {
      if (method === rpcMethods.sessionList) return { sessions: [summary] };
      if (method === rpcMethods.sessionPendingWaiters)
        return { toolPermissions: [], askUserQuestions: [] };
      if (method === rpcMethods.runtimeRun)
        return onRun(params as Record<string, unknown>, opts);
      throw new Error("unexpected: " + String(method));
    },
  );
}

function runCalls() {
  return fakeClient.request.mock.calls.filter(
    (c) => c[0] === rpcMethods.runtimeRun,
  );
}

function page() {
  return (
    <MemoryRouter initialEntries={[`/chat/${CID}`]}>
      <ThemeProvider>
        <SessionDetailView deviceId={1} conversationId={CID} form="page" />
      </ThemeProvider>
    </MemoryRouter>
  );
}

function mount() {
  const view = render(page());
  return { ...view, rerenderPage: () => view.rerender(page()) };
}

async function moveRelayTo(
  next: "connected" | "reconnecting",
  view: { rerenderPage: () => void },
) {
  relayState = next;
  await act(async () => view.rerenderPage());
}

function editorEl(): HTMLElement & {
  editor?: { commands: { setContent: (h: string) => void } };
} {
  return screen
    .getByTestId("session-composer-band")
    .querySelector(".ProseMirror") as never;
}

async function send(text: string) {
  await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
  act(() => editorEl().editor?.commands.setContent(`<p>${text}</p>`));
  fireEvent.click(await screen.findByTestId("session-detail-send"));
}

/** 让在途的 IndexedDB 事务与微任务落地。 */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

function seed(entry: Partial<OutboxEntry>) {
  return outboxStore.update(CID, (e) => {
    Object.assign(e, entry);
  });
}

describe("排队那一条跟着对话走（C2、I1）", () => {
  it("重连中排队 → 离开对话 → 回来仍在 → 连上只发一次，发完库里清掉", async () => {
    relayState = "reconnecting";
    stubRun(() => ({}));
    const first = mount();
    await send("改完帮我跑一下 relay 那组测试");
    await screen.findByTestId("send-pending");
    await settle();
    first.unmount();

    // 重载 / 回来：同一份库上一只新的页面。
    const second = mount();
    const queued = await screen.findByTestId("send-pending");
    expect(queued.textContent).toContain("改完帮我跑一下 relay 那组测试");
    expect(runCalls()).toHaveLength(0);

    await moveRelayTo("connected", second);
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect((runCalls()[0][1] as { userText?: string }).userText).toBe(
      "改完帮我跑一下 relay 那组测试",
    );
    await waitFor(() =>
      expect(screen.queryByTestId("send-pending")).toBeNull(),
    );
    await settle();
    expect(runCalls()).toHaveLength(1);
    expect(await outboxStore.get(CID)).toBeUndefined();
  });

  it("恢复出来的排队消息带着图：发出去的图与存下的逐字节一致", async () => {
    stubRun(() => ({}));
    const images = [
      shot,
      { ...shot, name: "b.png", dataUrl: "data:image/png;base64,/+8=" },
    ];
    await seed({ queued: { id: "q1", text: "  看这两张 \n图 ", images } });

    mount();
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    const params = runCalls()[0][1] as {
      userText?: string;
      userBlocks?: unknown;
    };
    expect(params.userBlocks).toEqual(encodeUserBlocks(images));
    // 发送照旧 trim（与今天直接发送同一规矩）；存下的那一份没被动过。
    expect(params.userText).toBe("看这两张 \n图");
  });

  it("「撤销」把整条消息（字与图）原样放回输入框，什么都不发", async () => {
    relayState = "reconnecting";
    stubRun(() => ({}));
    await seed({ queued: { id: "q1", text: "放回来的那句", images: [shot] } });

    const view = mount();
    const queued = await screen.findByTestId("send-pending");
    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    fireEvent.click(within(queued).getByTestId("send-pending-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("send-pending")).toBeNull(),
    );
    await waitFor(() => expect(editorEl().textContent).toBe("放回来的那句"));
    expect(
      within(screen.getByTestId("session-composer-band")).getByAltText(
        "shot.png",
      ),
    ).toBeTruthy();
    await settle();
    expect((await outboxStore.get(CID))?.queued).toBeUndefined();

    await moveRelayTo("connected", view);
    await settle();
    expect(runCalls()).toHaveLength(0);
  });

  it("「撤销」带图的那条时，输入框里刚写的字不被盖掉（还没落库也一样）", async () => {
    relayState = "reconnecting";
    stubRun(() => ({}));
    await seed({ queued: { id: "q1", text: "放回来的那句", images: [shot] } });

    mount();
    const queued = await screen.findByTestId("send-pending");
    await waitFor(() => expect(editorEl()?.editor).toBeTruthy());
    // 排队之后又写了一段：草稿的防抖保存还没触发就点「撤销」。
    act(() => editorEl().editor?.commands.setContent("<p>后来写的</p>"));
    fireEvent.click(within(queued).getByTestId("send-pending-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("send-pending")).toBeNull(),
    );
    await waitFor(() =>
      expect(editorEl().textContent).toContain("放回来的那句"),
    );
    expect(editorEl().textContent).toContain("后来写的");
    expect(
      within(screen.getByTestId("session-composer-band")).getByAltText(
        "shot.png",
      ),
    ).toBeTruthy();
  });

  it("存储不可用：照今天的内存行为，排队 → 连上发一次", async () => {
    delete g.indexedDB;
    relayState = "reconnecting";
    stubRun(() => ({}));
    const view = mount();
    await send("没有本地库也照发");
    await screen.findByTestId("send-pending");

    await moveRelayTo("connected", view);
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    await settle();
    expect(runCalls()).toHaveLength(1);
  });
});

describe("已交出（C3）：不发两次", () => {
  it("排着的那条连上时：先认领并记下「已交出」，之后才写出请求", async () => {
    let seen: OutboxEntry | undefined;
    stubRun(async () => {
      seen = await outboxStore.get(CID);
      return {};
    });
    await seed({ queued: { id: "q1", text: "先记账再出门" } });
    mount();
    await waitFor(() => expect(seen).toBeTruthy());
    // 请求出门那一刻：库里已经没有排队那一份（不会被再自动发），只有「已交出」。
    expect(seen!.queued).toBeUndefined();
    expect(seen!.handedOff.map((m) => [m.id, m.text])).toEqual([
      ["q1", "先记账再出门"],
    ]);
    expect(runCalls()).toHaveLength(1);
  });

  it("交出后、结果回来前 App 被杀：新实例落「可能已送达」，连着也不再发", async () => {
    const locks = installLocks();
    stubRun(() => new Promise(() => {}));
    const first = mount();
    await send("这条可能已经到了");
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    // 等「已交出」真的落库再杀。新消息的交出不等它落库就写出请求，而发送锁是在同一笔
    // 读-改-写里拿的：在它落库之前杀，测试里那段 JS 并没有真的停下，会在 crash() 之后
    // 才拿锁、才写库，新实例于是看到一把「还活着」的锁。真被杀时那段 JS 不会再跑。
    await waitFor(
      async () =>
        expect((await outboxStore.get(CID))?.handedOff).toHaveLength(1),
      { timeout: 5000 },
    );

    // 被杀：页面没了，在飞的请求永远不回来，它持有的锁被浏览器放掉。
    first.unmount();
    locks.crash();

    mount();
    // 新实例打开时的恢复把它落成「可能已送达」；落库之后气泡必定紧跟着画出来。
    await waitFor(
      async () =>
        expect((await outboxStore.get(CID))?.failed.map((f) => f.kind)).toEqual(
          ["transport"],
        ),
      { timeout: 5000 },
    );
    const bubble = await screen.findByTestId("send-failure", undefined, {
      timeout: 5000,
    });
    expect(bubble.getAttribute("data-failure-kind")).toBe("transport");
    // 标题说的是「可能已送达」，不是「没送到」（C3）。
    expect(bubble.textContent).toContain("May have reached");
    expect(bubble.textContent).not.toContain("Did not reach");
    expect(bubble.textContent).toContain("这条可能已经到了");
    await settle();
    expect(runCalls()).toHaveLength(1);
    expect(screen.queryByTestId("send-pending")).toBeNull();
    // 重载之后同样：它已经是一条失败，不再是「已交出」。
    const entry = await outboxStore.get(CID);
    expect(entry?.handedOff).toEqual([]);
    expect(entry?.failed.map((f) => f.kind)).toEqual(["transport"]);
  });

  it("另一个实例还在发（锁还被持有）：不把它当成被杀，它失败后这里才出气泡", async () => {
    installLocks();
    let fail: (err: unknown) => void = () => {};
    stubRun(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = mount();
    await send("还在路上");
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    await settle();
    first.unmount();

    mount();
    await settle();
    expect(screen.queryByTestId("send-failure")).toBeNull();

    await act(async () => fail(new RelayError(-32603, "busy")));
    const bubble = await screen.findByTestId("send-failure");
    expect(bubble.getAttribute("data-failure-kind")).toBe("rejected");
    expect(runCalls()).toHaveLength(1);
  });

  it("两个实例对着同一条排队消息：只有一个发得出去", async () => {
    installLocks();
    stubRun(() => ({}));
    await seed({ queued: { id: "q1", text: "只许发一次" } });

    render(
      <>
        {page()}
        {page()}
      </>,
    );
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    await settle();
    await settle();
    expect(runCalls()).toHaveLength(1);
  });
});

/**
 * 「可能已送达」看得见了就收起（规格 2026-11-25 K4）：同一对话的转录里出现了内容一致
 * （文字相同、图片数相同）且时间不早于交出时刻的用户消息时，气泡与库里那条一起撤掉；
 * 对不上就一直留着，永不自动重发。
 */
describe("「可能已送达」在转录里出现了就收起（K4）", () => {
  /** 镜像里这条对话的转录：几条用户消息，各带发生时刻。 */
  function serveTranscript(messages: { text: string; at: number }[]) {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/v1/devices") return { devices: [deviceRow] };
      if (path === "/v1/agent-sessions") return { items: [] };
      if (
        typeof path === "string" &&
        path.startsWith("/v1/agent-sessions/transcript")
      )
        return {
          frames: messages.map((m, i) => ({
            seq: i + 1,
            method: "runtime.event",
            createtime: m.at,
            params: {
              conversationId: CID,
              event: { kind: "user_message", text: m.text },
            },
          })),
          cursor: messages.length,
          has_more: false,
        };
      throw new Error("unexpected: " + path);
    });
  }

  it("发送时连接断了、回声随后到了：气泡收起，库里那条一并撤掉，不重发", async () => {
    let onEvent: ((frame: unknown, at?: number) => void) | undefined;
    mockUseRelay.mockImplementation((_t, opts) => {
      onEvent = (opts as { onEvent?: typeof onEvent } | undefined)?.onEvent;
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
    });
    stubRun(() => Promise.reject(new Error("socket closed")));
    mount();
    await send("这条其实到了");
    const bubble = await screen.findByTestId("send-failure");
    expect(bubble.getAttribute("data-failure-kind")).toBe("transport");

    await act(async () => {
      onEvent?.(
        {
          conversationId: CID,
          event: { kind: "user_message", text: "这条其实到了" },
          seq: 3,
        },
        Date.now(),
      );
    });

    await waitFor(() =>
      expect(screen.queryByTestId("send-failure")).toBeNull(),
    );
    await waitFor(async () =>
      expect((await outboxStore.get(CID))?.failed ?? []).toEqual([]),
    );
    expect(runCalls()).toHaveLength(1);
  });

  it("被杀后恢复出来的那条：转录里有它（交出之后），恢复即收起", async () => {
    const handedOffAt = Date.now() - 60_000;
    await seed({
      handedOff: [{ id: "h1", text: "杀掉之前发的", handedOffAt }],
    });
    serveTranscript([{ text: "杀掉之前发的", at: handedOffAt + 300 }]);
    stubRun(() => ({}));
    mount();

    expect(await screen.findByText("杀掉之前发的")).toBeTruthy();
    await waitFor(async () => {
      const entry = await outboxStore.get(CID);
      expect(entry?.failed ?? []).toEqual([]);
      expect(entry?.handedOff ?? []).toEqual([]);
    });
    expect(screen.queryByTestId("send-failure")).toBeNull();
    expect(runCalls()).toHaveLength(0);
  });

  it("对不上（文字改过 / 早于交出时刻）：一直留着，不猜", async () => {
    const handedOffAt = Date.now() - 60_000;
    await seed({
      failed: [
        { id: "f1", text: "部署一下", kind: "transport", handedOffAt },
        { id: "f2", text: "继续", kind: "transport", handedOffAt },
      ],
    });
    serveTranscript([
      { text: "部署一下吧", at: handedOffAt + 300 },
      { text: "继续", at: handedOffAt - 1 },
    ]);
    stubRun(() => ({}));
    mount();

    await screen.findByText("部署一下吧");
    await waitFor(() =>
      expect(screen.getAllByTestId("send-failure")).toHaveLength(2),
    );
    await settle();
    expect(screen.getAllByTestId("send-failure")).toHaveLength(2);
    expect((await outboxStore.get(CID))?.failed.map((f) => f.id)).toEqual([
      "f1",
      "f2",
    ]);
    expect(runCalls()).toHaveLength(0);
  });
});

describe("从失败气泡重发：不发两次（C3）", () => {
  it("两个实例对着同一条恢复出来的失败都点「重发」：只发一次，两边都不卡住", async () => {
    installLocks();
    let finish: () => void = () => {};
    stubRun(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    await seed({
      failed: [{ id: "f1", text: "只重发一次", kind: "rejected" }],
    });

    render(
      <>
        {page()}
        {page()}
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("send-failure-retry")).toHaveLength(2),
    );
    const [a, b] = screen.getAllByTestId("send-failure-retry");
    fireEvent.click(a);
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    fireEvent.click(b);
    await settle();
    await act(async () => finish());
    await settle();
    await settle();

    expect(runCalls()).toHaveLength(1);
    // 发件箱没被两把锁互相卡住：结果照常落库。
    await waitFor(async () =>
      expect(await outboxStore.get(CID)).toBeUndefined(),
    );
  });

  it("同一页连点两下「重发」：只发一次", async () => {
    stubRun(() => new Promise(() => {}));
    await seed({ failed: [{ id: "f1", text: "连点两下", kind: "rejected" }] });

    mount();
    const retry = await screen.findByTestId("send-failure-retry");
    fireEvent.click(retry);
    fireEvent.click(retry);
    await settle();
    await settle();

    expect(runCalls()).toHaveLength(1);
  });
});

describe("失败的那一条跟着对话走（C2、H8）", () => {
  it("被拒的消息：离开再回来仍是失败气泡，手机上与发送中同侧（右）；丢弃后库里清掉", async () => {
    stubRun(() => Promise.reject(new RelayError(-32603, "会话正忙")));
    const first = mount();
    await send("被拒了");
    const bubble = await screen.findByTestId("send-failure");
    expect(bubble.getAttribute("data-align")).toBe("end");
    await settle();
    first.unmount();

    mount();
    const again = await screen.findByTestId("send-failure");
    expect(again.getAttribute("data-failure-kind")).toBe("rejected");
    expect(again.textContent).toContain("被拒了");
    expect(again.getAttribute("data-align")).toBe("end");

    fireEvent.click(within(again).getByTestId("send-failure-discard"));
    await waitFor(() =>
      expect(screen.queryByTestId("send-failure")).toBeNull(),
    );
    await settle();
    expect(await outboxStore.get(CID)).toBeUndefined();
  });

  it("手机上气泡里的按键（撤销、重发、复制文本、丢弃）点按区 44px", async () => {
    relayState = "reconnecting";
    stubRun(() => ({}));
    await seed({
      queued: { id: "q1", text: "排着" },
      failed: [{ id: "f1", text: "没发出去", kind: "notSent" }],
    });
    mount();
    const cancel = await screen.findByTestId("send-pending-cancel");
    expect(cancel.className).toContain("min-h-11");
    for (const id of [
      "send-failure-retry",
      "send-failure-copy",
      "send-failure-discard",
    ]) {
      expect((await screen.findByTestId(id)).className).toContain("min-h-11");
    }
  });

  it("桌面上气泡按键照旧（不加 44px）", async () => {
    window.matchMedia = originalMatchMedia;
    relayState = "reconnecting";
    stubRun(() => ({}));
    await seed({
      queued: { id: "q1", text: "排着" },
      failed: [{ id: "f1", text: "没发出去", kind: "notSent" }],
    });
    mount();
    const cancel = await screen.findByTestId("send-pending-cancel");
    expect(cancel.className).not.toContain("min-h-11");
    expect(
      (await screen.findByTestId("send-failure-retry")).className,
    ).not.toContain("min-h-11");
  });

  it("换账号：清空本机业务数据后，这条对话的待发送与失败都读不到", async () => {
    await seed({
      queued: { id: "q1", text: "a" },
      failed: [{ id: "f1", text: "b", kind: "notSent" }],
    });
    await wipeBusinessData();
    bindAccount(2);
    expect(await outboxStore.get(CID)).toBeUndefined();
  });
});

describe("大图发送（C4）", () => {
  /** 约 300 KB 的图。 */
  const big = {
    ...shot,
    name: "big.png",
    dataUrl: "data:image/png;base64," + "A".repeat(300_000),
  };

  it("发送中显示「已传 / 共」；发完进度消失，从头到尾没有「取消」；等应答的上限按体积放宽", async () => {
    let report: (p: { sent: number; total: number }) => void = () => {};
    let opts: { timeoutMs?: number } | undefined;
    stubRun((_params, o) => {
      opts = o as typeof opts;
      report = (o as { onUpload: typeof report }).onUpload;
      return new Promise(() => {});
    });
    await seed({ queued: { id: "q1", text: "大图", images: [big] } });

    mount();
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(opts?.timeoutMs).toBeGreaterThan(RequestTimeoutMs);
    expect(opts?.timeoutMs).toBe(requestTimeoutFor(300_000 + 6 + 22));

    await act(async () => report({ sent: 100_000, total: 400_000 }));
    const sending = await screen.findByTestId("send-sending");
    const ring = within(sending).getByTestId("send-upload-progress");
    expect(ring.getAttribute("role")).toBe("progressbar");
    expect(ring.getAttribute("aria-valuenow")).toBe("25");
    expect(ring.textContent).toMatch(/100.*400/);
    expect(within(sending).queryByRole("button")).toBeNull();

    await act(async () => report({ sent: 400_000, total: 400_000 }));
    expect(within(sending).queryByTestId("send-upload-progress")).toBeNull();
    expect(within(sending).queryByRole("button")).toBeNull();
  });

  it("纯文字消息：不带上传进度，也不改等应答的上限", async () => {
    stubRun(() => ({}));
    mount();
    await send("一句话");
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0][2]).toBeUndefined();
  });

  it("上限：小消息照旧 30 秒，越大越宽", () => {
    expect(requestTimeoutFor(0)).toBe(RequestTimeoutMs);
    expect(requestTimeoutFor(5_000_000)).toBeGreaterThan(
      requestTimeoutFor(500_000),
    );
    expect(requestTimeoutFor(500_000)).toBeGreaterThan(RequestTimeoutMs);
  });
});

describe("手机首页行：「待发送」优先于「[草稿]」（C2）", () => {
  const row: MirrorIndexRow = {
    key: CID,
    conversationId: CID,
    sessionId: 0,
    deviceId: 1,
    fingerprint: "fp-1",
    machineFingerprint: "fp-1",
    agentSyncId: "ag-1",
    projectSyncId: "",
    updatedAt: 1754800000000,
    title: "重构登录页",
    lifecycleState: "idle",
    waitingForInput: false,
    lastReadAt: 0,
    saved: true,
  } as MirrorIndexRow;

  const noop = () => {};

  it("useOutboxMap：每条有排队消息的对话 → 它的正文", async () => {
    await seed({ queued: { id: "q1", text: "排队的\n第二行" } });
    const { result } = renderHook(() => useOutboxMap());
    await waitFor(() =>
      expect(result.current.get(CID)).toEqual({ text: "排队的\n第二行" }),
    );
  });

  it("useOutboxMap：只有失败（没发出去）的那条也算待发送；排队与失败都有时取排队那条", async () => {
    await seed({
      failed: [{ id: "f1", text: "没发出去的那句", kind: "notSent" }],
    });
    await outboxStore.update("other", (e) => {
      e.queued = { id: "q2", text: "排着的" };
      e.failed = [{ id: "f2", text: "失败的", kind: "notSent" }];
    });
    const { result } = renderHook(() => useOutboxMap());
    await waitFor(() =>
      expect(result.current.get(CID)).toEqual({ text: "没发出去的那句" }),
    );
    expect(result.current.get("other")).toEqual({ text: "排着的" });
  });

  it("同一条对话既有排队又有草稿：副行是「Pending: 首行」，不是「[Draft]」", async () => {
    await seed({ queued: { id: "q1", text: "\n 先发这句 \n第二行" } });
    await draftStore.put(`session:${CID}`, { text: "草稿那句", images: [] });

    render(
      <MemoryRouter>
        <ThemeProvider>
          <PhoneChatIndex
            scopeKey="all"
            scopeTitle="All"
            subtitle={{ text: "" }}
            onOpenScope={noop}
            onCompose={noop}
            searchQuery=""
            onSearchChange={noop}
            searchCount={0}
            settled
            rows={[row]}
            filter="all"
            onFilterChange={noop}
            counts={{ attention: 0, running: 0, unread: 0 }}
            agents={[]}
            projects={[]}
            hideAgent={false}
            sessionPath={() => "/chat/x"}
            stopTurnOf={() => undefined}
            filterAgentOf={() => undefined}
            filterMachineOf={() => undefined}
            onDelete={noop}
            onSave={noop}
            hasOnlineMachine
            onFindOnMachine={noop}
            hasMore={false}
            loadingMore={false}
            loadMoreFailed={false}
            onLoadMore={noop}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );

    const line = await screen.findByText("先发这句");
    const li = line.closest("li")!;
    expect(li.textContent).toContain("Pending:");
    expect(li.textContent).not.toContain("[Draft]");
    expect(li.textContent).not.toContain("草稿那句");
  });
});
