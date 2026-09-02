import { useLocation, useParams } from "react-router-dom";

import SessionDetailView from "@/components/session/SessionDetailView";

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
    title?: unknown;
    turnStartedAt?: unknown;
  } | null;
  const modelNote =
    typeof navState?.modelNote === "string" ? navState.modelNote : undefined;
  // 冷启动那一段的兜底标题（见 SessionDetailView 的 initialTitle）。与 modelNote
  // 同一条来路：从草稿页下钻过来时它就在手上，不必等摘要落地。
  const title =
    typeof navState?.title === "string" ? navState.title : undefined;
  // 第一轮是什么时候派发出去的（见 SessionDetailView 的 initialTurnStartedAt）。
  // 同样只有这一条来路：草稿页派发那一刻。
  const turnStartedAt =
    typeof navState?.turnStartedAt === "number"
      ? navState.turnStartedAt
      : undefined;
  return (
    <SessionDetailView
      deviceId={Number(deviceId)}
      conversationId={conversationId ?? ""}
      form="page"
      initialTitle={title}
      initialModelNote={modelNote}
      initialTurnStartedAt={turnStartedAt}
    />
  );
}
