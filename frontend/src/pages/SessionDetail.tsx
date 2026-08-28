import { useLocation, useParams } from "react-router-dom";

import SessionDetailView from "@/components/session/SessionDetailView";

/**
 * 会话详情路由页：把路由参数交给可复用的 SessionDetailView（form="page"），
 * 自身只做参数解析。真实 relay attach/catchup/origin、待审批/提问、发消息、
 * 七类状态全部在 SessionDetailView 里 —— 桌面 Chat 右栏以
 * form="embedded" 消费同一份实现（任务 5）。
 */
export default function SessionDetail() {
  const { deviceId, sessionId } = useParams();
  // 移动端从草稿页下钻过来时，「模型没能钉住」那一句随导航 state 一起来 ——
  // 它说的是发起那一刻的事，没有别的来路，也不该进 URL。
  const { state } = useLocation();
  const modelNote =
    typeof (state as { modelNote?: unknown } | null)?.modelNote === "string"
      ? (state as { modelNote: string }).modelNote
      : undefined;
  return (
    <SessionDetailView
      deviceId={Number(deviceId)}
      sessionId={Number(sessionId)}
      form="page"
      initialModelNote={modelNote}
    />
  );
}
