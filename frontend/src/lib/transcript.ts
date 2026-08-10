/**
 * 转录渲染（R8）：浏览器读到的转录与桌面端一致，但渲染的保真度不在本轮承诺范围
 * 内 —— 只做通用形态，不识别的工具按原始形态如实呈现而不是隐藏。
 *
 * 把 wire 事件帧流（EventFrame[]）归约成可渲染的块列表。识别这些 kind（与 Go
 * agentruntime.EventKind 一致）：text_delta / thinking_delta / user_message /
 * tool_use_start / tool_result / error / done；ask_user_question /
 * tool_permission_request 渲成信息卡（可操作输入在 DecisionPanel，按 requestId
 * 对回）；其余一切 kind 落成 raw 块，原样呈现原始 JSON。
 */

export const EVENT_KIND_TEXT_DELTA = "text_delta";
export const EVENT_KIND_THINKING_DELTA = "thinking_delta";
export const EVENT_KIND_USER_MESSAGE = "user_message";
export const EVENT_KIND_TOOL_USE_START = "tool_use_start";
export const EVENT_KIND_TOOL_RESULT = "tool_result";
export const EVENT_KIND_ERROR = "error";
export const EVENT_KIND_DONE = "done";
export const EVENT_KIND_ASK_USER_QUESTION = "ask_user_question";
export const EVENT_KIND_TOOL_PERMISSION_REQUEST = "tool_permission_request";

export type TranscriptItemKind =
  | "message"
  | "thinking"
  | "tool"
  | "toolResult"
  | "error"
  | "decision"
  | "raw"
  | "turnDone";

export interface TranscriptItem {
  kind: TranscriptItemKind;
  /** 稳定的本地身份（累加 / 归并的依据，也是渲染层的 React key）。 */
  id: string;
  role?: "user" | "assistant";
  text?: string;
  fromDevice?: string;
  toolName?: string;
  /** tool_use_start 报的工具调用标识；tool_result 按它对回这张卡。 */
  toolCallId?: string;
  toolInput?: string;
  result?: string;
  resultIsError?: boolean;
  requestId?: string;
  /** raw / decision 块里的原始事件。 */
  eventKind?: string;
  raw?: unknown;
}

export interface TranscriptEvent {
  sessionId: number;
  event?: unknown;
  seq?: number;
}

function kindOf(ev: unknown): string | undefined {
  if (typeof ev !== "object" || ev === null) return undefined;
  const k = (ev as Record<string, unknown>).kind;
  return typeof k === "string" ? k : undefined;
}

function str(ev: unknown, key: string): string | undefined {
  if (typeof ev !== "object" || ev === null) return undefined;
  const v = (ev as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function bool(ev: unknown, key: string): boolean | undefined {
  if (typeof ev !== "object" || ev === null) return undefined;
  const v = (ev as Record<string, unknown>)[key];
  return typeof v === "boolean" ? v : undefined;
}

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * 块 id 就是它在列表里的位置。它必须由归约结果自己决定,不能来自一个模块级自增
 * 计数器:SessionDetail 每来一条实时帧就把**整段**事件流重新归约一次,计数器每
 * 归约一轮就换一批 id,而 id 正是 Transcript 的 React key —— 每一个 token 都会
 * 让整段转录 unmount/remount(文本选中被清掉、滚动锚点丢失,块越多重建越贵)。
 *
 * 位置是稳定的:块只往后追加,累积(text_delta / tool_result)改的是原地那一个,
 * 因此同一条历史块在每一次重新归约里都落在同一个下标上。
 */
function idAt(index: number): string {
  return `b${index}`;
}

/** 还没有结果的那张工具卡的下标（按 toolCallId），没有则 -1。 */
function indexOfToolCall(items: TranscriptItem[], callId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (
      it.kind === "tool" &&
      it.toolCallId === callId &&
      it.result === undefined
    ) {
      return i;
    }
  }
  return -1;
}

/** 兼容老 daemon（结果不带 toolCallId）：只认紧挨着的那一张未结束的工具卡。 */
function lastUnresolvedTool(items: TranscriptItem[]): number {
  const last = items.length - 1;
  const it = items[last];
  return it && it.kind === "tool" && it.result === undefined ? last : -1;
}

/** 把一条事件归约进当前块列表（纯函数：返回新数组）。 */
export function reduceEvent(
  items: TranscriptItem[],
  ev: TranscriptEvent,
): TranscriptItem[] {
  const kind = kindOf(ev.event);
  switch (kind) {
    case EVENT_KIND_TEXT_DELTA: {
      const text = str(ev.event, "text") ?? "";
      if (!text) return items;
      const last = items[items.length - 1];
      if (last && last.kind === "message" && last.role === "assistant") {
        const copy = [...items];
        copy[copy.length - 1] = { ...last, text: `${last.text ?? ""}${text}` };
        return copy;
      }
      return [
        ...items,
        { kind: "message", role: "assistant", text, id: idAt(items.length) },
      ];
    }
    case EVENT_KIND_THINKING_DELTA: {
      const text = str(ev.event, "text") ?? "";
      if (!text) return items;
      const last = items[items.length - 1];
      if (last && last.kind === "thinking") {
        const copy = [...items];
        copy[copy.length - 1] = { ...last, text: `${last.text ?? ""}${text}` };
        return copy;
      }
      return [...items, { kind: "thinking", text, id: idAt(items.length) }];
    }
    case EVENT_KIND_USER_MESSAGE:
      return [
        ...items,
        {
          kind: "message",
          role: "user",
          text: str(ev.event, "text") ?? "",
          fromDevice: str(ev.event, "sourceDeviceName"),
          id: idAt(items.length),
        },
      ];
    case EVENT_KIND_TOOL_USE_START:
      return [
        ...items,
        {
          kind: "tool",
          toolName: str(ev.event, "name") ?? "tool",
          toolCallId: str(ev.event, "id"),
          toolInput: pretty((ev.event as Record<string, unknown>)?.input),
          id: idAt(items.length),
        },
      ];
    case EVENT_KIND_TOOL_RESULT: {
      const content = str(ev.event, "content") ?? "";
      const isError = bool(ev.event, "isError") ?? false;
      // 结果按 toolCallId 对回它自己的那张卡:一条 assistant 消息可以同时起好几个
      // 工具调用(Read + Grep),此时「最后一张还没有结果的卡」并不是它 —— 只看最后
      // 一张会把 Read 的输出挂到 Grep 卡上,用户读到张冠李戴的工具输出。
      // 两端的标识都是 omitempty,老 daemon 不盖时退回到原来的「紧挨着的那一张」。
      const callId = str(ev.event, "toolCallId");
      const at = callId
        ? indexOfToolCall(items, callId)
        : lastUnresolvedTool(items);
      if (at >= 0) {
        const copy = [...items];
        copy[at] = { ...copy[at], result: content, resultIsError: isError };
        return copy;
      }
      return [
        ...items,
        {
          kind: "toolResult",
          result: content,
          resultIsError: isError,
          id: idAt(items.length),
        },
      ];
    }
    case EVENT_KIND_ERROR:
      return [
        ...items,
        {
          kind: "error",
          text: str(ev.event, "message") ?? "error",
          id: idAt(items.length),
        },
      ];
    case EVENT_KIND_ASK_USER_QUESTION:
      return [
        ...items,
        {
          kind: "decision",
          eventKind: kind,
          requestId: str(ev.event, "requestId"),
          text: str(ev.event, "requestId") ?? "",
          raw: ev.event,
          id: idAt(items.length),
        },
      ];
    case EVENT_KIND_TOOL_PERMISSION_REQUEST:
      return [
        ...items,
        {
          kind: "decision",
          eventKind: kind,
          requestId: str(ev.event, "requestId"),
          toolName: str(ev.event, "toolName"),
          raw: ev.event,
          id: idAt(items.length),
        },
      ];
    case EVENT_KIND_DONE:
      return [...items, { kind: "turnDone", id: idAt(items.length) }];
    default:
      // 不识别的 kind:按原始形态如实呈现,不隐藏(R8)。
      return [
        ...items,
        { kind: "raw", eventKind: kind, raw: ev.event, id: idAt(items.length) },
      ];
  }
}

/** 整段事件流 → 块列表。 */
export function reduceEvents(events: TranscriptEvent[]): TranscriptItem[] {
  return events.reduce(
    (acc, ev) => reduceEvent(acc, ev),
    [] as TranscriptItem[],
  );
}
