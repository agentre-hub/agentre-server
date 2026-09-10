import { Clock3, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, ChatMessage, cn } from "@agentre-hub/agentre-ui";

/**
 * 排着队等连接的那一条（规格 2026-08-21 决策 6）。
 *
 * 重连期间输入框不再禁用——重连通常几秒就回来，禁用换来的只是让人干等着，而这
 * 段时间里想说的那句话得自己记住。发送因此变成「排一条队，连上自动发出」。
 *
 * 这条队**看得见**是有意的：一条静默的队列，要么在连上那一刻突然发出、要么永远
 * 没发出去，两种都比说清楚更坏。撤销就在旁边——排着不等于必须发。
 *
 * 外壳是共享包的 `ChatMessage variant="user"`，与转录里一条真用户消息**同一个
 * 组件**：同样的「我」头像、同样的行首对齐、同样的正文列。此前这里是自画的
 * 右对齐气泡（`max-w-[84%] self-end`），而它就站在转录流里紧挨着真消息 —— 于是
 * 「我刚敲进去的那句」与「已经发出去的那句」在同一列里长得不是一个东西。
 *
 * 只有**外壳**换了。「这条还没发出去」靠虚线边与那行小字说，不靠位置说。
 */
export default function PendingSendBubble({
  text,
  onCancel,
}: {
  text: string;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ChatMessage
      variant="user"
      // author / avatar 在 user 档上不被使用（包自己画中性的「我」），但类型上是
      // 必填。传空串而不是编一个名字：这一行本来就没有「谁说的」这个问题。
      author=""
      avatar={null}
      // 还没发出去，没有「什么时候发的」可言。不编一个时刻，与本站别处
      // 「取不到就不显示」同一条。
      time=""
      role="status"
      data-testid="send-pending"
      // 外层**不吃** padding/border：它们会把整行（含头像）一起往右推，
      // 「我」那一列就与上下两条真消息错开一格 —— 而这一轮要的正是同一列。
      // 记号落在正文那一列里（见下面的包裹层）。
      className="py-0.5"
      meta={
        <Button
          size="xs"
          variant="ghost"
          data-testid="send-pending-cancel"
          onClick={onCancel}
        >
          <X aria-hidden="true" className="size-3" />
          {t("session.sendPending.cancel")}
        </Button>
      }
    >
      {/* 虚线 + 弱底：一眼看得出「还没出去」，但只占正文这一列。 */}
      <div
        className={cn(
          "rounded-lg border border-dashed border-border-strong bg-secondary/60 px-3 py-2",
        )}
      >
        <p className="mb-1 flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
          <Clock3 aria-hidden="true" className="size-3 shrink-0" />
          {t("session.sendPending.title")}
        </p>
        {/* 用户自己写的那段字。动态内容，不进 t(...)。 */}
        <p className="whitespace-pre-wrap break-words text-foreground">
          {text}
        </p>
      </div>
    </ChatMessage>
  );
}
