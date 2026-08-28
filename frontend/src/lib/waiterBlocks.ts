/**
 * `runtime.session.pendingWaiters` 的待决 → 共享包的 canonical 块。
 *
 * 转录里的审批卡与提问卡由共享包的 `reduceFrames` 从**事件流**归约出来，包的
 * `CanonicalToolRouter` 据此渲染。而待决策面板的数据来自**一次 RPC**，形状不同，
 * 此前因此在本站手画了第二份卡。这个模块把 waiter 搬成同一形态，两条来源从此
 * 汇进同一批组件。
 *
 * **两份清单仍然不合并**（见 `SessionDetailView` 里 `panelWaiters` 的说明）：
 * 事件流画得出的那些由转录承担，waiters 只补它画不出的。这里消掉的是画法，
 * 不是来源。
 *
 * 字段名要搬：daemon 那边是 agentruntime 的结构体、没有 JSON tag，顶层是
 * PascalCase（`RequestID` / `ToolName` / `Input` / `Questions`）；包的 DTO 是
 * camelCase。不搬的话 tsc 照样过（`questions` 在包里的类型是 `unknown`），
 * 而卡片渲染出来每一问都是空的。
 */
import type { TranscriptBlock } from "@agentre-hub/agentre-ui";

/** `pendingWaiters.toolPermissions` 的一项。 */
export interface PendingToolPermissionShape {
  RequestID?: string;
  ToolName?: string;
  Input?: unknown;
}

/** `pendingWaiters.askUserQuestions` 的一项。 */
export interface PendingAskQuestionShape {
  RequestID?: string;
  Questions?: AskQuestionShape[];
}

export interface AskQuestionShape {
  ID?: string;
  Question?: string;
  Header?: string;
  MultiSelect?: boolean;
  IsOther?: boolean;
  Options?: { Label?: string; Description?: string }[];
}

export interface PendingWaiters {
  toolPermissions: PendingToolPermissionShape[];
  askUserQuestions: PendingAskQuestionShape[];
}

/**
 * 提交给 `runtime.submitAnswer` 的一条答案。与上面几个同族：这是 **daemon 那侧**
 * 的形状（PascalCase），不是包的 —— 包的端口收的是 camelCase 的
 * `{ questionIndex, labels, otherText }`，两者之间的搬运在 `SessionDetailView`
 * 的 `submitAnswerPort` 里，那里写明了为什么不能强转。
 */
export interface AskAnswerSubmit {
  QuestionIndex: number;
  Labels: string[];
  OtherText: string;
}

/**
 * 一张待决卡。`requestId` 单独拎出来是给宿主做 key 与预检用的 —— 从块里再挖一次
 * 要穿两层可选字段，而调用方本来就需要它。
 */
export interface WaiterBlock {
  requestId: string;
  block: TranscriptBlock;
}

/**
 * 只有 `Record<string, unknown>` 能进包的 `toolInput`；别的形状一律当没有。
 *
 * 取不到时给 `{}` 而不是 undefined：块级的 `toolInput` 在包的类型里是**必填**的，
 * 而归约器那条路（包内 `frames.ts` 的 `record()`）拿不到时给的也是 `{}`。
 * 两条来源在这一格上保持同形，卡片就不必分辨自己是从哪来的。
 */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function toQuestionDTO(q: AskQuestionShape) {
  return {
    // 逐个可选字段都只在**有值时**才落键：包的 DTO 里它们是可选的，
    // 补一个 undefined 进去会让快照与相等断言多出一堆空键。
    ...(q.ID !== undefined ? { id: q.ID } : {}),
    question: q.Question ?? "",
    ...(q.Header !== undefined ? { header: q.Header } : {}),
    ...(q.MultiSelect !== undefined ? { multiSelect: q.MultiSelect } : {}),
    ...(q.IsOther !== undefined ? { isOther: q.IsOther } : {}),
    options: (q.Options ?? []).map((o) => ({
      label: o.Label ?? "",
      ...(o.Description !== undefined ? { description: o.Description } : {}),
    })),
  };
}

/**
 * 待决清单 → 卡片块。授权在前、提问在后，与面板此前的顺序一致。
 *
 * 没有 `RequestID` 的一律跳过：没有它就无从提交，包的卡片自己也会 `return null`。
 * 与其渲染一张点不动的卡，不如不出——而这一条同时是去重的前提（认不出是同一条
 * 待决时，`SessionDetailView` 会把它留给面板）。
 */
export function waiterBlocks(waiters: PendingWaiters): WaiterBlock[] {
  const out: WaiterBlock[] = [];

  for (const tp of waiters.toolPermissions) {
    if (!tp.RequestID) continue;
    const toolPermission = {
      requestId: tp.RequestID,
      toolName: tp.ToolName ?? "",
      toolInput: asRecord(tp.Input),
    };
    out.push({
      requestId: tp.RequestID,
      block: {
        // type 与归约器给事件流那条一致，卡片的路由只看 canonical，
        // 但保持同名让两条来源在 devtools 里也认得出是同一种东西。
        type: "tool_permission_request",
        toolPermission,
        canonical: { kind: "tool.permission", toolPermission },
      },
    });
  }

  for (const aq of waiters.askUserQuestions) {
    if (!aq.RequestID) continue;
    const questions = (aq.Questions ?? []).map(toQuestionDTO);
    out.push({
      requestId: aq.RequestID,
      block: {
        type: "ask_user_question",
        askUserQuestion: { requestId: aq.RequestID, questions },
        canonical: {
          kind: "user.ask",
          userAsk: { requestId: aq.RequestID, questions },
        },
      },
    });
  }

  return out;
}
