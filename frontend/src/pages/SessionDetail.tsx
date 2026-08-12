import { useParams } from "react-router-dom";

import SessionDetailView from "@/components/session/SessionDetailView";

/**
 * 会话详情路由页：把路由参数交给可复用的 SessionDetailView（form="page"），
 * 自身只做参数解析。真实 relay attach/catchup/origin、待审批/提问、发消息、
 * 移动关注与六类状态全部在 SessionDetailView 里 —— 桌面 Chat 右栏以
 * form="embedded" 消费同一份实现（任务 5）。
 */
export default function SessionDetail() {
  const { deviceId, sessionId } = useParams();
  return (
    <SessionDetailView
      deviceId={Number(deviceId)}
      sessionId={Number(sessionId)}
      form="page"
    />
  );
}
