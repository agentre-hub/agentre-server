import { useLocation, useParams } from "react-router-dom";

import SessionDetailView from "@/components/session/SessionDetailView";

/** 导航 state 是历史记录里的东西，没人担保它的形状：逐格取用前先验一把。 */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * 会话详情路由页：把路由参数交给可复用的 SessionDetailView（form="page"），
 * 自身只做参数解析。真实 relay attach/catchup/origin、待审批/提问、发消息、
 * 七类状态全部在 SessionDetailView 里 —— 桌面 Chat 右栏以
 * form="embedded" 消费同一份实现（任务 5）。
 */
export default function SessionDetail() {
  const { deviceId, conversationId } = useParams();
  // 移动端从草稿页下钻过来时，「模型没能钉住」那一句随导航 state 一起来 ——
  // 它说的是发起那一刻的事，没有别的来路，也不该进 URL。
  const { state } = useLocation();
  const navState = state as {
    modelNote?: unknown;
    effortNote?: unknown;
    title?: unknown;
    userText?: unknown;
    turnStartedAt?: unknown;
    agent?: unknown;
  } | null;
  const modelNote = str(navState?.modelNote);
  // 「力度没能钉住」那一句，与 modelNote 同一条来路、同一种处置。
  const effortNote = str(navState?.effortNote);
  // 冷启动那一段的兜底标题（见 SessionDetailView 的 initialTitle）。与 modelNote
  // 同一条来路：从草稿页下钻过来时它就在手上，不必等摘要落地。
  const title = str(navState?.title);
  // 刚发出去那一句（见 SessionDetailView 的 initialUserText）。与 title 同一条来路：
  // 草稿页派发那一刻就在手上，而转录的两条真来路都还要往返。
  const userText = str(navState?.userText);
  // 第一轮是什么时候派发出去的（见 SessionDetailView 的 initialTurnStartedAt）。
  // 同样只有这一条来路：草稿页派发那一刻。
  const turnStartedAt = num(navState?.turnStartedAt);
  // 这条对话属于哪个 Agent（见 SessionDetailView 的 initialAgent）。同一条来路：
  // 草稿页那一屏是用户亲手挑的，下钻时顺手带过来，落地那一帧就说得出名字与头像。
  //
  // 逐格验形状再用：这两格缺一个都画不出一枚有身份的头像，那就当没给。
  const agentSeed =
    typeof navState?.agent === "object" && navState.agent !== null
      ? (navState.agent as Record<string, unknown>)
      : null;
  const agentSyncID = str(agentSeed?.sync_id);
  const agentName = str(agentSeed?.name);
  const agent =
    agentSyncID !== undefined && agentName !== undefined
      ? {
          sync_id: agentSyncID,
          name: agentName,
          avatar_color: str(agentSeed?.avatar_color),
          avatar_icon: str(agentSeed?.avatar_icon),
        }
      : undefined;
  return (
    <SessionDetailView
      deviceId={Number(deviceId)}
      conversationId={conversationId ?? ""}
      form="page"
      initialTitle={title}
      initialUserText={userText}
      initialAgent={agent}
      initialModelNote={modelNote}
      initialEffortNote={effortNote}
      initialTurnStartedAt={turnStartedAt}
    />
  );
}
