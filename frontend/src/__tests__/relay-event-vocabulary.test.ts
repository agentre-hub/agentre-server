/**
 * relay 事件词表的穿透守卫：真 Protobuf 帧 → RelayClient → reduceFrames → 块。
 *
 * ## 为什么必须整条穿过去
 *
 * 本站在 `relayClient` 里把 Protobuf 的 oneof case 名（`toolCall`）翻成转录归约
 * 认的 kind 判别值（`tool_use_start`）。这一跳此前没有任何测试覆盖 —— 已有的
 * `relay-client-protobuf.test.ts` 只喂 `textDelta`，而 `textDelta` 恰好是两边拼法
 * 一致的那一档；`transcript-frames.test.ts` 又直接手写 `{kind:"tool_use_start"}`
 * 对象喂给归约器，根本不过那张翻译表。
 *
 * 结果是四条映射写错了（`tool_call` / `user_ask_request` / `user_ask_resolved` /
 * `usage_update` 都不在 `EventKind` 词表里）也全绿：类型上 `kindOf` 是断言不是
 * 校验，`never` 穷尽检查够不着；运行期落进 `default` 分支被当未知事件铺成一坨
 * JSON notice。编译器绿、测试绿、界面坏。
 *
 * 所以这里的断言一律落在**最终块**上，不落在中间的 kind 字符串上 —— 只对 kind
 * 断言的话，载荷形态错了（`bytes` 字段原样是 Uint8Array）照样测不出来。
 */
import {
  ProtobufRpcCodec,
  rpcMethods,
  type RuntimeEventNotificationFrame,
  EventAskUserQuestion,
  EventAskUserQuestionAnswered,
  EventCompactBoundary,
  EventContextWindowUpdated,
  EventDone,
  EventError,
  EventExecApprovalRequested,
  EventExecApprovalResolved,
  EventOutputActivity,
  EventPermissionModeChanged,
  EventPlanUpdated,
  EventRetry,
  EventRuntimeStatus,
  EventSteerConsumed,
  EventSubagentDone,
  EventSubagentModel,
  EventSubagentProgress,
  EventSubagentStarted,
  EventTextDelta,
  EventThinkingDelta,
  EventToolPermissionRequest,
  EventToolPermissionResolved,
  EventToolResult,
  EventToolUseStart,
  EventUnrecognizedBlock,
  EventUsage,
  EventUserMessage,
  type EventKind,
} from "@agentre-hub/agentre-wire";
import { describe, expect, it, vi } from "vitest";

import {
  reduceFrames,
  reduceSessionState,
  type TranscriptFrame,
} from "@agentre-hub/agentre-ui";

import {
  applyJournalFrames,
  RelayClient,
  type RelayClientOptions,
} from "@/lib/relayClient";
import { RelayConnection } from "@/lib/relayConnection";
import { unwrapEnvelope, wrapEnvelope } from "@/lib/relayEnvelope";
import { machineTarget } from "@/lib/relayTarget";

const CID = "11111111-1111-7111-8111-111111111111";

/** Protobuf `RuntimeEventNotification.event` oneof 的全部 case 名。 */
type RuntimeEventCase = RuntimeEventNotificationFrame["event"]["case"];

class BinarySocket {
  readyState = 0;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  /** 通道号：第一帧是目标声明（决策 10），它属于连接那一层，这里不计。 */
  channelId = "";

  send(data: unknown): void {
    const { channelId, frame } = unwrapEnvelope(data as Uint8Array);
    if (this.channelId === "") {
      this.channelId = channelId;
      return;
    }
    this.sent.push(frame);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: Uint8Array): void {
    this.onmessage?.({ data: wrapEnvelope(this.channelId, data) });
  }
}

/**
 * 把若干条 runtime 事件当作真 Protobuf 帧喂给 RelayClient，收下它吐给宿主的
 * 转录帧。走的是生产同一条 `onEvent` 出口，没有任何测试专用短路。
 */
async function relayEvents(
  events: readonly RuntimeEventNotificationFrame["event"][],
): Promise<TranscriptFrame[]> {
  const socket = new BinarySocket();
  const received: TranscriptFrame[] = [];
  const connection = new RelayConnection({
    url: "ws://relay.test/v1/relay/client",
    jwt: "jwt",
    reconnect: false,
    createWebSocket: () => socket as unknown as WebSocket,
  });
  const options: RelayClientOptions = {
    connection,
    target: machineTarget("fp-daemon"),
    credential: () => "jwt",
    // 转录投影那一格由宿主补（见 transcriptFrame）；这一族只关心事件本身。
    onEvent: (event) =>
      received.push({ ...event, sessionId: 1 } as TranscriptFrame),
  };
  const client = new RelayClient(options);
  const connected = client.connect();
  socket.open();
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  const handshake = ProtobufRpcCodec.decode(socket.sent[0]);
  socket.receive(
    ProtobufRpcCodec.encodeTypedMethodResponse(
      handshake.id,
      rpcMethods.authAccount,
      { ok: true },
    ),
  );
  await connected;

  events.forEach((event, index) => {
    socket.receive(
      ProtobufRpcCodec.encode({
        id: 0n,
        body: {
          case: "runtimeEventNotification",
          conversationId: CID,
          seq: index + 1,
          event,
        },
      }),
    );
  });
  await vi.waitFor(() => expect(received).toHaveLength(events.length));
  return received;
}

const utf8 = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

/**
 * 每个 oneof case 一份最小样本。写成 `Record<RuntimeEventCase, …>` 而不是数组：
 * Go 那边新增一个事件、wire 包重新生成之后，这张表会在**编译期**变红，逼一次
 * 「它翻成哪个 kind」的决定 —— 而不是等到线上多出一坨 JSON notice。
 */
const SAMPLES: Record<
  RuntimeEventCase,
  RuntimeEventNotificationFrame["event"]
> = {
  textDelta: { case: "textDelta", text: "hi" },
  thinkingDelta: { case: "thinkingDelta", text: "hmm" },
  outputActivity: { case: "outputActivity" },
  permissionModeChanged: { case: "permissionModeChanged", mode: "plan" },
  retry: { case: "retry", message: "m", details: "d", attempt: 1, max: 3 },
  contextWindowUpdated: { case: "contextWindowUpdated", tokens: 10 },
  compactBoundary: {
    case: "compactBoundary",
    preTokens: 2,
    postTokens: 1,
    trigger: "auto",
    durationMs: 5,
  },
  runtimeStatus: { case: "runtimeStatus", status: "compacting" },
  done: {
    case: "done",
    model: "",
    durationMs: 0,
    firstTokenMs: 0,
    tokensPerSec: 0,
  },
  error: { case: "error", message: "boom" },
  userMessage: {
    case: "userMessage",
    text: "hello",
    sourceDevice: "",
    sourceDeviceName: "",
  },
  toolCall: {
    case: "toolCall",
    id: "t1",
    name: "Read",
    input: utf8({ file_path: "/tmp/a" }),
  },
  toolResult: { case: "toolResult", toolCallId: "t1", content: "ok" },
  steerConsumed: { case: "steerConsumed" },
  userAskRequest: {
    case: "userAskRequest",
    requestId: "q1",
    questions: [{ question: "去哪", header: "路线", options: [] }],
  },
  userAskResolved: { case: "userAskResolved", requestId: "q1" },
  toolPermissionRequest: {
    case: "toolPermissionRequest",
    requestId: "p1",
    toolName: "Bash",
    input: utf8({ command: "ls" }),
  },
  toolPermissionResolved: {
    case: "toolPermissionResolved",
    requestId: "p1",
    allowed: true,
  },
  execApprovalRequested: {
    case: "execApprovalRequested",
    id: "e1",
    commandText: "ls",
    createdAtMs: 1,
    expiresAtMs: 2,
  },
  execApprovalResolved: {
    case: "execApprovalResolved",
    id: "e1",
    status: "resolved",
    resolvedAtMs: 3,
  },
  subagentStarted: { case: "subagentStarted", toolCallId: "s1" },
  subagentProgress: { case: "subagentProgress", toolCallId: "s1" },
  subagentDone: { case: "subagentDone", toolCallId: "s1" },
  subagentModel: { case: "subagentModel", toolCallId: "s1", model: "opus" },
  usageUpdate: {
    case: "usageUpdate",
    usage: { promptTokens: 11, completionTokens: 22 },
    totalInputTokens: 33,
  },
  planUpdated: { case: "planUpdated", text: "plan" },
  unrecognizedBlock: {
    case: "unrecognizedBlock",
    blockType: "future_block",
    data: utf8({ nested: { keep: true } }),
  },
};

/** `EventKind` 词表的运行期形态。手写字面量的话守卫就成了复制品。 */
const VOCABULARY: ReadonlySet<string> = new Set<EventKind>([
  EventTextDelta,
  EventThinkingDelta,
  EventOutputActivity,
  EventToolUseStart,
  EventToolResult,
  EventSteerConsumed,
  EventSubagentStarted,
  EventSubagentProgress,
  EventSubagentDone,
  EventSubagentModel,
  EventAskUserQuestion,
  EventAskUserQuestionAnswered,
  EventPlanUpdated,
  EventToolPermissionRequest,
  EventToolPermissionResolved,
  EventExecApprovalRequested,
  EventExecApprovalResolved,
  EventPermissionModeChanged,
  EventRetry,
  EventUsage,
  EventCompactBoundary,
  EventRuntimeStatus,
  EventError,
  EventDone,
  EventUserMessage,
  EventContextWindowUpdated,
  EventUnrecognizedBlock,
]);

describe("relay 事件词表", () => {
  // Given daemon 在 oneof 上发来任意一种 runtime 事件；When 帧穿过 relayClient
  // 的视图适配；Then 判别值必须落在 EventKind 词表内 —— 落在词表外就等于转录
  // 归约的 switch 一定走 default，用户看到的是一坨 JSON 而不是卡片。
  it("每个 oneof case 都翻成词表内的 kind", async () => {
    const cases = Object.keys(SAMPLES) as RuntimeEventCase[];
    const frames = await relayEvents(cases.map((name) => SAMPLES[name]));

    const strays = frames
      .map((frame, index) => ({
        case: cases[index],
        kind: (frame.event as { kind?: unknown } | undefined)?.kind,
      }))
      .filter((entry) => !VOCABULARY.has(String(entry.kind)));

    expect(strays).toEqual([]);
  });

  // Given 助手起了一次工具调用；When 帧一路走到转录归约；Then 应当得到一张
  // 带工具名与**已解析入参**的 tool_use 块。入参在 wire 上是 bytes（Go 侧的
  // json.RawMessage），照搬过来会变成一个按字节下标编号的对象。
  it("工具调用渲染成 tool_use 块,入参是解析后的对象", async () => {
    const frames = await relayEvents([SAMPLES.toolCall]);
    const [message] = reduceFrames(frames, 7);

    expect(message.blocks).toEqual([
      {
        type: "tool_use",
        toolUseId: "t1",
        toolName: "Read",
        toolInput: { file_path: "/tmp/a" },
      },
    ]);
  });

  // Given 后端发起一次 AskUserQuestion 并随后带回答案；When 两帧都穿过来；
  // Then 应当是**一张**被回填成已答的提问卡，而不是两条未知事件。
  it("提问与其答案合成同一张已回填的卡", async () => {
    const frames = await relayEvents([
      SAMPLES.userAskRequest,
      {
        case: "userAskResolved",
        requestId: "q1",
        answers: [{ questionIndex: 0, labels: ["左边"], otherText: "" }],
      },
    ]);
    const [message] = reduceFrames(frames, 7);

    expect(message.blocks).toHaveLength(1);
    expect(message.blocks[0].type).toBe("ask_user_question");
    expect(message.blocks[0].askUserQuestion).toMatchObject({
      requestId: "q1",
      answered: true,
    });
  });

  // Given turn 中途上报了一次 usage；When 帧穿过来；Then token 应当落在消息级
  // 字段上（Composer 的 token 列），正文里不多出任何块。
  it("usage 落到消息的 token 列而不是正文", async () => {
    const frames = await relayEvents([SAMPLES.textDelta, SAMPLES.usageUpdate]);
    const [message] = reduceFrames(frames, 7);

    expect(message.promptTokens).toBe(11);
    expect(message.completionTokens).toBe(22);
    expect(message.totalInputTokens).toBe(33);
    expect(message.blocks.map((block) => block.type)).toEqual(["text"]);
  });

  // Given 桌面端遇到一条它投射不出来的转录块并如实转发；When 帧穿过来；Then 本站
  // 把块类型与**解析后的原始载荷**画出来，而不是一坨 base64 或一行 "unknown"。
  //
  // data 在 wire 上是 bytes（Go 侧的 json.RawMessage）—— 这条同时钉住那一层还原：
  // 少了它，用户看到的是按字节下标编号的对象。
  it("投射不出来的块画出块类型与原始载荷", async () => {
    const frames = await relayEvents([SAMPLES.unrecognizedBlock]);
    const [message] = reduceFrames(frames, 7);

    expect(message.blocks).toHaveLength(1);
    expect(message.blocks[0].type).toBe("notice");
    expect(message.blocks[0].text).toContain("future_block");
    expect(message.blocks[0].raw).toEqual({
      blockType: "future_block",
      data: { nested: { keep: true } },
    });
  });

  // Given 后端不单发 context_window_updated、只把窗口挂在 usage 帧上；When 帧
  // 穿过来；Then 底栏的上下文计量器仍拿得到窗口大小。totalInputTokens 与
  // contextWindow 都是 UsageUpdate 自己的字段，不在嵌套的 Usage 里 —— 读错层
  // 的话计量器永远是 0%，而手写事件对象的测试恰好会把读错层一起写进去。
  it("usage 帧上的 contextWindow 兜得住没有单独窗口帧的后端", async () => {
    const frames = await relayEvents([
      {
        case: "usageUpdate",
        usage: { promptTokens: 1 },
        totalInputTokens: 100,
        contextWindow: 64000,
      },
    ]);

    expect(reduceSessionState(frames).contextWindow).toBe(64000);
  });
  // Given 这些事件已经落进日志，被当作历史回放（server 镜像的
  // `/v1/agent-sessions/transcript`、中继的 `session.pull` 与往回续读三条路都
  // 汇到同一个 `{method, params}` 中间形状）；When 这一页经 applyJournalFrames
  // 回放；Then 每一帧必须与它当初实时穿过来时**一模一样**。
  //
  // 回放要把中间形状翻回 oneof case 名，那是 EVENT_KINDS 的反向。它此前是按
  // snake_case → camelCase **猜**的，而 EVENT_KINDS 自己的注释就写着两边没有可
  // 推导的规则（`tool_use_start` 的 case 是 `toolCall`）。猜错的那几种翻回来是
  // 词表外的判别值，归约器的 switch 落进 default —— 历史里的工具卡与提问卡就此
  // 铺成一坨 JSON，而同一条对话正在跑的那一轮（不过回放）是好的。
  //
  // 断言整帧相等而不只是 kind：载荷也要原样，少一层就是卡片空着。
  it("日志回放一遍不改变任何一帧", async () => {
    const cases = Object.keys(SAMPLES) as RuntimeEventCase[];
    const live = await relayEvents(cases.map((name) => SAMPLES[name]));

    const replayed: TranscriptFrame[] = [];
    applyJournalFrames(
      live.map((frame, index) => ({
        seq: index + 1,
        method: "runtime.event",
        params: { conversationId: CID, seq: index + 1, event: frame.event },
      })) as unknown as Parameters<typeof applyJournalFrames>[0],
      {
        onEvent: (frame) =>
          replayed.push({ ...frame, sessionId: 1 } as TranscriptFrame),
      },
    );

    expect(replayed).toEqual(live);
  });
});
