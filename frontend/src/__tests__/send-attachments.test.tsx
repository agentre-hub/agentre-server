/**
 * 贴在一条消息上的图,从按下发送到它落地为止,一路都还在。
 *
 * 发送这条路上有三处会把用户刚贴的图弄丢,而三处都**不报错**:
 *
 *   1. 重连期间排的那一条(决策 6)只排了 `body` 一个字符串,连上之后重发的那条是
 *      纯文本 —— 图在排队那一瞬间就没了;
 *   2. 任何一次发送失败,失败气泡(决策 7)只留文本。而输入框在提交那一刻已经被
 *      `ChatComposer` 清空,图既不在气泡里、也不在输入框里,那颗「重发」发出去的
 *      是一条**和用户写的不一样**的消息;
 *   3. 一轮正在跑时带图发,`sendRouted` 抛的是个裸 `Error`,`classifySendFailure`
 *      认不出它、归成 `transport`,于是气泡说的是「连接断了,可能已经送达」——
 *      而真实情况是这条压根没出门,原因也不是网络。
 *
 * 三条的判据都是同一句:**用户贴的东西,和他写的字一样重要**。
 */
import {
  act,
  renderHook,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rpcMethods } from "@agentre-hub/agentre-wire";
import type { SessionSummary } from "@agentre-hub/agentre-wire";

import { RelayError } from "@/lib/relayClient";

import "@/i18n";
import PendingSendBubble from "@/components/session/PendingSendBubble";
import SendFailureBubble from "@/components/session/SendFailureBubble";
import {
  useSessionSend,
  useTurnActivity,
} from "@/components/session/useSessionSend";
import { useSteerQueue } from "@/components/session/useSteerQueue";
import type { SessionViewStatus } from "@/lib/sessionView";

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

const client = { request: vi.fn(), catchUp: vi.fn(async () => {}) };

/** 一张 1×3 字节的假 png,`inline` 那一半是 base64 的 `AQID`。 */
const shot = {
  dataUrl: "data:image/png;base64,AQID",
  mediaType: "image/png",
  name: "shot.png",
};

/** 这一份就是 `runtime.run` 上该出现的那一块。 */
const shotBlock = {
  type: "image",
  data: new TextEncoder().encode(
    JSON.stringify({ media_type: "image/png", source: { inline: "AQID" } }),
  ),
};

function useSend(status: SessionViewStatus) {
  const turn = useTurnActivity("A");
  // 队列是这一屏本地的乐观状态，走 steer 的那条路会往里挂条目；这几条用例测的是
  // 发送本身，真接一只就够（不桩它，免得漏掉「chip 没挂上」这类回归）。
  const steerQueue = useSteerQueue();
  const send = useSessionSend({
    did: 1,
    sid: "A",
    originProp: undefined,
    status,
    summary,
    relayTicket: relayTicket as never,
    clientRef: { current: client as never },
    originRef: { current: undefined },
    turn,
    effectiveTarget: { providerKey: "", modelKey: "" },
    effectivePermissionMode: "default",
    setPinnedAgentredUnavailable: () => {},
    steerQueue,
  });
  return { turn, send };
}

/** 这几次 `runtime.run` 各自带的 `userBlocks`。 */
function runBlocks(): unknown[] {
  return client.request.mock.calls
    .filter(([method]) => method === rpcMethods.runtimeRun)
    .map(([, params]) => (params as Record<string, unknown>).userBlocks);
}

beforeEach(() => {
  client.request.mockReset();
});

describe("发送路径上的附件", () => {
  it("Given 发送失败, When 那条落进失败气泡, Then 图跟着字一起留在气泡里", async () => {
    client.request.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useSend("connected"));

    await act(async () => {
      await result.current.send.sendMessage({
        text: "这张图哪里不对",
        images: [shot],
      });
    });

    // 字留下了、图没留下的话,「重发」发出去的是另一条消息 —— 而用户看着屏幕上
    // 那条以为自己重发的是刚写的那条。
    expect(result.current.send.failedSends[0]).toMatchObject({
      text: "这张图哪里不对",
      images: [shot],
    });
  });

  it("Given 重发一条带图的失败消息, When 它发出去, Then 图还在这一次 run 上", async () => {
    client.request.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useSend("connected"));

    await act(async () => {
      await result.current.send.sendMessage({
        text: "这张图哪里不对",
        images: [shot],
      });
    });
    client.request.mockResolvedValue({});
    const failure = result.current.send.failedSends[0];
    await act(async () => {
      await result.current.send.retryFailedSend(failure);
    });

    expect(runBlocks()).toEqual([[shotBlock], [shotBlock]]);
    expect(result.current.send.failedSends).toEqual([]);
  });

  it("Given 重连期间发一条带图的, When 连接回来, Then 排着的那条把图一起发出去", async () => {
    client.request.mockResolvedValue({});
    const { result, rerender } = renderHook(
      ({ status }) => useSend(status as SessionViewStatus),
      { initialProps: { status: "reconnecting" as SessionViewStatus } },
    );

    await act(async () => {
      await result.current.send.sendMessage({
        text: "这张图哪里不对",
        images: [shot],
      });
    });
    // 排着队时一帧都不该发出去（决策 6）。
    expect(client.request).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ status: "connected" as SessionViewStatus });
    });

    expect(runBlocks()).toEqual([[shotBlock]]);
  });

  /**
   * 一轮正在跑时带图发:`runtime.steer` 只带得动文本(它的参数里就只有 `text`),
   * 所以这条**确实**发不出去。要紧的是把这句话说对。
   *
   * 此前它归 `transport`,而那一档的文案是「连接断了,可能已经送达 —— 再发一次
   * 可能变成两条」。三件事全是假的:连接好好的、这条没送达、重发是干净的。
   */
  it("Given 一轮正在跑, When 带图发一条, Then 气泡说的是这一轮在跑,不是连接断了", async () => {
    const { result } = renderHook(() => useSend("connected"));
    act(() => result.current.turn.markTurnActive(true));

    await act(async () => {
      await result.current.send.sendMessage({
        text: "这张图哪里不对",
        images: [shot],
      });
    });

    // 一帧都没发出去 —— 所以这一条的重发是干净的。
    expect(client.request).not.toHaveBeenCalled();
    expect(result.current.send.failedSends[0]).toMatchObject({
      text: "这张图哪里不对",
      images: [shot],
      kind: "imageWhileRunning",
    });
  });

  /**
   * 选路的**回落**那一支同样不许把图偷偷丢掉。
   *
   * `sendRouted` 认定「这一轮没在跑」时走 `runtime.run`;对端明确拒绝(rejected)时
   * 它回落去 `runtime.steer` —— 而 steer 的参数里只有 `text`。竞态正是这么发生的:
   * 别的设备刚在这条会话上开了一轮,`turnActiveRef` 这份快照还没跟上,run 被拒,
   * 回落的 steer **成功**了。
   *
   * 于是屏幕上这一条显示成发出去了(还摆着「已排队」),而模型从头到尾没看见那张图。
   * 静默丢图比一个明确的错误坏得多:用户没有任何理由再发一次。
   *
   * 带图时这一条**没有**第二条路,所以交出的是对端自己那句拒绝的原话(已由对端
   * 本地化)——它才是对当前状态的描述。不编一个我们并没有观察到的原因。
   */
  it("Given 这一轮其实在跑而 run 被拒, When 回落去 steer, Then 带图那条不静默改成纯文本", async () => {
    client.request.mockImplementation(async (method) => {
      // 对端说「这条会话已经在跑了」——一个正经的 peer 错误码,归 rejected。
      if (method === rpcMethods.runtimeRun) {
        throw new RelayError(-32001, "a turn is already running");
      }
      return {};
    });
    const { result } = renderHook(() => useSend("connected"));

    await act(async () => {
      await result.current.send.sendMessage({
        text: "这张图哪里不对",
        images: [shot],
      });
    });

    // steer 一帧都不该发出去:它带不动图。
    expect(
      client.request.mock.calls.filter(
        ([method]) => method === rpcMethods.runtimeSteer,
      ),
    ).toEqual([]);
    // 这一条落进气泡,转述的是对端那句原话,图跟着留下 —— 重发是干净的。
    expect(result.current.send.failedSends[0]).toMatchObject({
      text: "这张图哪里不对",
      images: [shot],
      kind: "rejected",
      detail: "a turn is already running",
    });
  });

  it("Given 没带图, When run 被拒, Then 回落去 steer 这条路一如从前", async () => {
    client.request.mockImplementation(async (method) => {
      if (method === rpcMethods.runtimeRun) {
        throw new RelayError(-32001, "a turn is already running");
      }
      return {};
    });
    const { result } = renderHook(() => useSend("connected"));

    await act(async () => {
      await result.current.send.sendMessage({ text: "只有文字" });
    });

    expect(
      client.request.mock.calls.filter(
        ([method]) => method === rpcMethods.runtimeSteer,
      ),
    ).toHaveLength(1);
    expect(result.current.send.failedSends).toEqual([]);
  });

  /**
   * 一条消息在屏幕上只该有一个去处。
   *
   * 「重发失败时**原地更新**那一条」是这条流的既定规矩（决策 7 的注释里写着:同一段
   * 字在流里出现两次只会让人以为自己发了两遍）。而 `sendMessage` 里那两档「一帧都
   * 没发出去」的早退 —— 重连排队与「还没就绪」—— 都没有把 `replacing` 往下传:
   * 从一条失败气泡上按「重发」而这时连接正在重连,那一条会被排进队,**同时**原来
   * 那条气泡还留在流里。同一条消息于是同时以两个身份摆在屏幕上,一个说排着队、
   * 一个说没发出去,而它们其实是同一条。
   */
  it("Given 从失败气泡重发, When 这时正在重连, Then 它排进队而不是另外再留一条旧气泡", async () => {
    client.request.mockRejectedValue(new Error("boom"));
    const { result, rerender } = renderHook(
      ({ status }) => useSend(status as SessionViewStatus),
      { initialProps: { status: "connected" as SessionViewStatus } },
    );

    await act(async () => {
      await result.current.send.sendMessage({ text: "这张图哪里不对" });
    });
    const failure = result.current.send.failedSends[0];
    expect(failure).toBeTruthy();

    rerender({ status: "reconnecting" as SessionViewStatus });
    await act(async () => {
      await result.current.send.retryFailedSend(failure);
    });

    expect(result.current.send.pendingSend).toMatchObject({
      text: "这张图哪里不对",
    });
    expect(result.current.send.failedSends).toEqual([]);
  });
});

describe("排队与失败那两条气泡里的附件", () => {
  it("Given 一条带图的排着队, When 渲染气泡, Then 图摆在字旁边", () => {
    render(
      <PendingSendBubble
        text="这张图哪里不对"
        images={[shot]}
        onCancel={() => {}}
      />,
    );

    const row = screen.getByTestId("send-pending");
    expect(within(row).getByAltText("shot.png").getAttribute("src")).toBe(
      shot.dataUrl,
    );
  });

  it("Given 一条带图的没发出去, When 渲染气泡, Then 图摆在字旁边", () => {
    render(
      <SendFailureBubble
        failure={{
          id: "f1",
          text: "这张图哪里不对",
          kind: "notSent",
          images: [shot],
        }}
        onRetry={() => {}}
        onDiscard={() => {}}
      />,
    );

    const row = screen.getByTestId("send-failure");
    expect(within(row).getByAltText("shot.png").getAttribute("src")).toBe(
      shot.dataUrl,
    );
  });

  it("Given 「这一轮在跑」那一档, When 渲染气泡, Then 主动作是干净的重发,文案说的是那一轮", () => {
    render(
      <SendFailureBubble
        failure={{ id: "f1", text: "x", kind: "imageWhileRunning" }}
        machineName="mac-studio-01"
        onRetry={() => {}}
        onDiscard={() => {}}
      />,
    );

    const row = screen.getByTestId("send-failure");
    expect(row.dataset.failureKind).toBe("imageWhileRunning");
    // 没走到对端,重发是干净的 —— 不该摆 transport 那颗「检查后重发」。
    expect(within(row).getByTestId("send-failure-retry").textContent).toContain(
      "Resend",
    );
    expect(row.textContent).toContain("Images can't join a running turn");
  });
});
