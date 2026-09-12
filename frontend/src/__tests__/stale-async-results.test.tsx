/**
 * 在途异步结果没有目标守卫时，会落到**解析那一刻打开的那个**会话 / 范围上。
 *
 * 三条同源（发送、转录续读、索引翻页）：请求发出去那一刻的目标不等于它回来那一刻
 * 的目标，而右栏与索引都是**同实例换 props**（没有 key 强制重挂），于是过期的那一
 * 份被当成当前这一份写了进去。
 *
 * 另外两条是同一族的「陈旧状态」：一次失败之后不清错、机器答过一次之后永远不再
 * 显示不可达。
 */
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "@agentre-hub/agentre-wire";

import { api } from "@/lib/api";
import type { DeviceItem } from "@/lib/devices";
import type { RelayState } from "@/lib/relayClient";
import { useRelayChannel } from "@/hooks/use-relay";
import { loadMirrorTail } from "@/components/session/sessionMirror";
import {
  useSessionSend,
  useTurnActivity,
} from "@/components/session/useSessionSend";
import { useSteerQueue } from "@/components/session/useSteerQueue";
import { useTranscriptScrollback } from "@/components/session/useTranscriptScrollback";
import type { SessionEventFrame } from "@/components/session/transcriptFrame";
import { useSessionIndex } from "@/pages/chat/useSessionIndex";
import {
  useMachineReachability,
  type MachineReachability,
} from "@/pages/chat/useMachineReachability";
import type { IndexResponse, MirroredSession } from "@/pages/chat/chatRows";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/hooks/use-relay", () => ({ useRelayChannel: vi.fn() }));
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});
vi.mock("@/components/session/sessionMirror", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/session/sessionMirror")>();
  return { ...actual, loadMirrorTail: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockedMirrorTail = vi.mocked(loadMirrorTail);
const mockUseRelay = vi.mocked(useRelayChannel);

/** 一个手动兑现的 promise：把「在飞」这段时间摊开来，好在中间换目标。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── 1. 发送 ──────────────────────────────────────────────────────────────

const summary = {
  conversationId: "A",
  title: "重构登录页",
  agentSyncId: "ag-1",
  cwd: "/home/agent/proj",
  backendType: "claudecode",
  lifecycleState: "idle",
} as unknown as SessionSummary;

const relayTicket = {
  peerFingerprint: "fp-web",
  clientName: "Browser",
  accessToken: "t",
  expiresAt: Date.now() + 120_000,
};

const sendClient = { request: vi.fn(), catchUp: vi.fn(async () => {}) };

/** 两只 hook 在详情视图里是前后脚跑的，测试也照那个顺序装起来。 */
function useSend(sid: string, withSummary = true) {
  const turn = useTurnActivity(sid);
  // 队列是这一屏本地的乐观状态，走 steer 的那条路会往里挂条目；这几条用例测的是
  // 发送本身，真接一只就够（不桩它，免得漏掉「chip 没挂上」这类回归）。
  const steerQueue = useSteerQueue();
  const send = useSessionSend({
    did: 1,
    sid,
    originProp: undefined,
    status: "connected",
    summary: withSummary ? summary : null,
    relayTicket: relayTicket as never,
    clientRef: { current: sendClient as never },
    originRef: { current: undefined },
    turn,
    effectiveTarget: { providerKey: "", modelKey: "" },
    effectivePermissionMode: "default",
    setPinnedAgentredUnavailable: () => {},
    steerQueue,
  });
  return { turn, send };
}

describe("在途发送：目标换了就不落在新目标上", () => {
  beforeEach(() => {
    sendClient.request.mockReset();
  });

  it("Given A 的发送在飞时切到 B, When A 的发送失败, Then B 上不长出带 A 文本的失败气泡", async () => {
    const gate = deferred<unknown>();
    sendClient.request.mockReturnValue(gate.promise);

    const { result, rerender } = renderHook(({ sid }) => useSend(sid), {
      initialProps: { sid: "A" },
    });

    let sent!: Promise<void>;
    act(() => {
      sent = result.current.send.sendMessage("A 的稿子");
    });
    rerender({ sid: "B" });
    await act(async () => {
      gate.reject(new Error("boom"));
      await sent;
    });

    // 这条字属于 A。挂在 B 下面的话，点它的重试会用 sid=B 真的把它发进 B。
    expect(result.current.send.failedSends).toEqual([]);
  });

  it("Given 目标没换, When 发送失败, Then 失败气泡照旧挂出来", async () => {
    sendClient.request.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(({ sid }) => useSend(sid), {
      initialProps: { sid: "A" },
    });
    await act(async () => {
      await result.current.send.sendMessage("A 的稿子");
    });

    expect(result.current.send.failedSends).toHaveLength(1);
    expect(result.current.send.failedSends[0].text).toBe("A 的稿子");
  });

  it("Given A 的发送在飞时切到 B, When A 的发送成功, Then B 不被置成「这一轮在跑」", async () => {
    const gate = deferred<unknown>();
    sendClient.request.mockReturnValue(gate.promise);

    const { result, rerender } = renderHook(({ sid }) => useSend(sid), {
      initialProps: { sid: "A" },
    });

    let sent!: Promise<void>;
    act(() => {
      sent = result.current.send.sendMessage("A 的稿子");
    });
    rerender({ sid: "B" });
    await act(async () => {
      gate.resolve({});
      await sent;
    });

    expect(result.current.turn.turnActive).toBe(false);
    expect(result.current.turn.pendingAssistant).toBe(false);
  });

  // 输入框只按连接状态启用（SessionComposerBand），而摘要可能还没到手 / 已经没了。
  it("Given 摘要还没到手, When 发一条, Then 那段字留在屏幕上，而不是无声消失", async () => {
    const { result } = renderHook(() => useSend("A", false));

    await act(async () => {
      await result.current.send.sendMessage("会不会消失");
    });

    expect(sendClient.request).not.toHaveBeenCalled();
    expect(result.current.send.failedSends).toHaveLength(1);
    // 一次请求都没发出去，所以重发是干净的 —— 与 transport 那一类分开。
    expect(result.current.send.failedSends[0]).toMatchObject({
      text: "会不会消失",
      kind: "notSent",
    });
  });
});

// ── 2. 转录的「加载更早」 ────────────────────────────────────────────────

function useScrollback(sid: string) {
  const [events, setEvents] = useState<SessionEventFrame[]>([]);
  const scrollback = useTranscriptScrollback({
    did: 1,
    sid,
    originProp: undefined,
    events,
    setEvents,
    clientRef: { current: null },
    originRef: { current: undefined },
  });
  return { events, scrollback };
}

function frame(text: string): SessionEventFrame {
  return {
    seq: 1,
    at: 1,
    event: { kind: "text_delta", text },
  } as unknown as SessionEventFrame;
}

describe("在途的「加载更早」：目标换了就不拼进新目标的转录", () => {
  beforeEach(() => {
    mockedMirrorTail.mockReset();
  });

  it("Given A 往回读的那一页在飞时切到 B, When 它回来, Then 不前插进 B 的转录", async () => {
    const gate = deferred<Awaited<ReturnType<typeof loadMirrorTail>>>();
    mockedMirrorTail.mockReturnValue(gate.promise);

    const { result, rerender } = renderHook(({ sid }) => useScrollback(sid), {
      initialProps: { sid: "A" },
    });

    act(() => result.current.scrollback.noteMirrorHistory(10, true));
    act(() => result.current.scrollback.retryEarlier());
    rerender({ sid: "B" });
    await act(async () => {
      gate.resolve({
        events: [frame("A 的旧消息")],
        oldestSeq: 1,
        hasBefore: false,
      } as never);
    });

    expect(result.current.events).toEqual([]);
  });

  it("Given 目标没换, When 那一页回来, Then 照旧前插进转录", async () => {
    mockedMirrorTail.mockResolvedValue({
      events: [frame("A 的旧消息")],
      oldestSeq: 1,
      hasBefore: false,
    } as never);

    const { result } = renderHook(({ sid }) => useScrollback(sid), {
      initialProps: { sid: "A" },
    });

    act(() => result.current.scrollback.noteMirrorHistory(10, true));
    await act(async () => {
      result.current.scrollback.retryEarlier();
    });

    await waitFor(() => expect(result.current.events).toHaveLength(1));
  });

  /*
    切走再切回**同一条**对话：守卫从前比的是目标串，而 A→B→A 之后这个串与第一趟
    一模一样，于是第一趟迟到回来的那一页照样算「还在」，前插进第二趟自己已经读过
    的转录里——同一段话说两遍，而且插在最前面（往回读那一路是前插且不去重）。

    「还是那条对话」不等于「还是那一趟」：中间那次切换已经把 `events` 清空、把
    「更早的」进度打回 none，第一趟捕获的 `oldestSeq` 说的是一份不复存在的转录。
  */
  it("Given A 的那一页在飞时切到 B 再切回 A, When 它回来, Then 不再前插一遍", async () => {
    const gate = deferred<Awaited<ReturnType<typeof loadMirrorTail>>>();
    const page = {
      events: [frame("上一轮的回复")],
      oldestSeq: 1,
      hasBefore: false,
    } as never;
    mockedMirrorTail.mockReturnValueOnce(gate.promise);

    const { result, rerender } = renderHook(({ sid }) => useScrollback(sid), {
      initialProps: { sid: "A" },
    });

    // 第一趟：往回读那一页发出去了，还没回来。
    act(() => result.current.scrollback.noteMirrorHistory(10, true));
    act(() => result.current.scrollback.retryEarlier());

    // 切到 B 再切回 A —— 两次都跟着详情视图渲染期那段重置。
    rerender({ sid: "B" });
    act(() => result.current.scrollback.reset());
    rerender({ sid: "A" });
    act(() => result.current.scrollback.reset());

    // 切回来这一趟自己把同一页读了回来。
    mockedMirrorTail.mockResolvedValue(page);
    act(() => result.current.scrollback.noteMirrorHistory(10, true));
    await act(async () => {
      result.current.scrollback.retryEarlier();
    });
    expect(result.current.events).toHaveLength(1);

    // 第一趟迟到了。
    await act(async () => {
      gate.resolve(page);
    });
    expect(result.current.events).toHaveLength(1);
  });
});

// ── 3 / 5b. 索引 ────────────────────────────────────────────────────────

function mirrored(over: Partial<MirroredSession> = {}): MirroredSession {
  return {
    peer_fingerprint: "fp-1",
    device_fingerprint: "fp-1",
    conversation_id: "42",
    title: "重构登录页",
    lifecycle_state: "idle",
    last_message_at: 1754800000000,
    ...over,
  };
}

function useIndex(filter: "all" | "unread") {
  return useSessionIndex({
    axis: "time",
    devices: [],
    filter,
    onDeleted: () => {},
  });
}

describe("索引：在途翻页与陈旧的错误横幅", () => {
  beforeEach(() => {
    mockedApi.mockReset();
  });

  it("Given 时间轴的下一页在飞时换了筛选, When 它回来, Then 不追加到新范围的列表下面", async () => {
    const gate = deferred<IndexResponse>();
    mockedApi.mockImplementation(async (path: string) => {
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      if (params.get("cursor")) return gate.promise;
      if (params.get("per_group") === "1") return { total: 0 };
      return {
        total: 2,
        groups: [
          {
            scope: "time",
            total: 2,
            items: [mirrored()],
            cursor: "c1",
            has_more: true,
          },
        ],
      };
    });

    const { result, rerender } = renderHook(({ f }) => useIndex(f), {
      initialProps: { f: "all" as "all" | "unread" },
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    rerender({ f: "unread" });
    await act(async () => {
      gate.resolve({
        total: 2,
        items: [mirrored({ conversation_id: "99", title: "过期那一页" })],
        has_more: true,
        cursor: "c2",
      });
    });

    expect(
      result.current.mirrorRows.some((r) => r.conversation_id === "99"),
    ).toBe(false);
  });

  it("Given 一次取数失败过, When 下一次成功, Then 那条红横幅收起来", async () => {
    let fail = true;
    mockedApi.mockImplementation(async (path: string) => {
      if (fail) throw new Error("flaky");
      const params = new URLSearchParams(path.split("?")[1] ?? "");
      if (params.get("per_group") === "1") return { total: 0 };
      return { total: 1, groups: [{ scope: "time", total: 1, items: [] }] };
    });

    const { result, rerender } = renderHook(({ f }) => useIndex(f), {
      initialProps: { f: "all" as "all" | "unread" },
    });
    await waitFor(() => expect(result.current.loadError).toBeTruthy());

    fail = false;
    rerender({ f: "unread" });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.loadError).toBeNull();
  });
});

// ── 5c. 机器可达性 ───────────────────────────────────────────────────────

/**
 * 机器答过一次之后就再也不显示不可达：`resolved[fingerprint]` 短路掉了
 * `machineState` 的判断，而 `resolved` 只增不减（只有离开机器轴才清）。agentred
 * 之后挂了，那一组仍摆着「已连接」与一份陈旧清单，组头上也没有重试入口。
 */
let relayState: RelayState = "connected";
const machineClient = { request: vi.fn(), close: vi.fn() };

let reachOut: MachineReachability | null = null;

function ReachProbe({ devices }: { devices: DeviceItem[] }) {
  const reach = useMachineReachability({
    devices,
    axis: "machine",
    keyword: "",
  });
  // 渲染期改外部变量被 react-hooks/globals 禁掉（那是副作用）；这里只是把每次提交
  // 之后的那一份交出去给断言读，放 effect 里正合适。
  useEffect(() => {
    reachOut = reach;
  });
  return <>{reach.resolvers}</>;
}

const machine: DeviceItem = {
  id: 1,
  name: "书房小主机",
  kind: "agentred",
  fingerprint: "fp-1",
  last_seen_at: 1754000000000,
  status: 1,
  online: true,
} as unknown as DeviceItem;

describe("机器可达性：答过一次之后仍要认得出掉线", () => {
  beforeEach(() => {
    relayState = "connected";
    machineClient.request.mockReset();
    machineClient.request.mockResolvedValue({ sessions: [] });
    mockUseRelay.mockReset();
    mockUseRelay.mockImplementation(() => ({
      client: machineClient as never,
      relayState,
      relayTicket: relayTicket as never,
      relayTicketError: null,
      handshakeRejection: null,
      reconnect: vi.fn(),
    }));
    reachOut = null;
  });

  it("Given 一台机器已经交出过清单, When 它掉线, Then 那一组转成不可达（重试入口才出得来）", async () => {
    const { rerender } = render(<ReachProbe devices={[machine]} />);
    await waitFor(() => expect(reachOut?.machineStates[1]).toBe("connected"));

    relayState = "reconnecting";
    rerender(<ReachProbe devices={[machine]} />);

    await waitFor(() => expect(reachOut?.machineStates[1]).toBe("unreachable"));
  });
});
