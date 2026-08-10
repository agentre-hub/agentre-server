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
  /** 稳定的本地身份（累加 / 归并的依据）。 */
  id: string;
  role?: "user" | "assistant";
  text?: string;
  fromDevice?: string;
  toolName?: string;
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

let blockSeq = 0;
function nextId(): string {
  blockSeq += 1;
  return `b${blockSeq}`;
}

export function resetTranscriptIds(): void {
  blockSeq = 0;
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
        { kind: "message", role: "assistant", text, id: nextId() },
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
      return [...items, { kind: "thinking", text, id: nextId() }];
    }
    case EVENT_KIND_USER_MESSAGE:
      return [
        ...items,
        {
          kind: "message",
          role: "user",
          text: str(ev.event, "text") ?? "",
          fromDevice: str(ev.event, "sourceDeviceName"),
          id: nextId(),
        },
      ];
    case EVENT_KIND_TOOL_USE_START:
      return [
        ...items,
        {
          kind: "tool",
          toolName: str(ev.event, "name") ?? "tool",
          toolInput: pretty((ev.event as Record<string, unknown>)?.input),
          id: nextId(),
        },
      ];
    case EVENT_KIND_TOOL_RESULT: {
      const content = str(ev.event, "content") ?? "";
      const isError = bool(ev.event, "isError") ?? false;
      const last = items[items.length - 1];
      if (last && last.kind === "tool" && last.result === undefined) {
        const copy = [...items];
        copy[copy.length - 1] = {
          ...last,
          result: content,
          resultIsError: isError,
        };
        return copy;
      }
      return [
        ...items,
        {
          kind: "toolResult",
          result: content,
          resultIsError: isError,
          id: nextId(),
        },
      ];
    }
    case EVENT_KIND_ERROR:
      return [
        ...items,
        {
          kind: "error",
          text: str(ev.event, "message") ?? "error",
          id: nextId(),
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
          id: nextId(),
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
          id: nextId(),
        },
      ];
    case EVENT_KIND_DONE:
      return [...items, { kind: "turnDone", id: nextId() }];
    default:
      // 不识别的 kind:按原始形态如实呈现,不隐藏(R8)。
      return [
        ...items,
        { kind: "raw", eventKind: kind, raw: ev.event, id: nextId() },
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
