import { Clock3, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  ChatMessage,
  type ChatImageAttachment,
} from "@agentre-hub/agentre-ui";

import SendAttachments from "@/components/session/SendAttachments";
import type { UploadProgress } from "@/lib/relayClient";

/** 字节数按当前语言写成「340 kB」「1.5 MB」（十进制单位，与系统文件大小同一口径）。 */
function formatBytes(bytes: number, locale: string): string {
  const mb = bytes >= 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: mb ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(bytes / (mb ? 1_000_000 : 1_000));
}

/**
 * 大图发送中的进度环（规格 2026-11-25 决策 C4）：随实际已交给网络的字节推进，旁边写
 * 「已传 / 共」。没有「取消」：已经交给 WebSocket 的帧浏览器撤不回，取消了再重发就是
 * 两条。
 */
function UploadRing({ progress }: { progress: UploadProgress }) {
  const { t, i18n } = useTranslation();
  const ratio = progress.total > 0 ? progress.sent / progress.total : 0;
  const percent = Math.round(ratio * 100);
  const r = 7;
  const circumference = 2 * Math.PI * r;
  return (
    <div
      role="progressbar"
      aria-label={t("session.sendPending.uploadProgress")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-testid="send-upload-progress"
      className="mb-1 flex items-center gap-1.5 text-2xs text-muted-foreground"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 18 18"
        className="size-4 shrink-0 -rotate-90"
      >
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="2"
          className="stroke-current opacity-25"
        />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          className="stroke-current text-primary-text"
        />
      </svg>
      <span className="tabular-nums">
        {t("session.sendPending.uploaded", {
          sent: formatBytes(progress.sent, i18n.language),
          total: formatBytes(progress.total, i18n.language),
        })}
      </span>
    </div>
  );
}

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
 * 只有**外壳**换了。「这条还没发出去」靠那行小字说，不靠位置说；手机上再加一道
 * 虚线边（见下面的包裹层）。
 *
 * 两档（弱网规格 2026-11-20 决策 12 / 13）：
 *   - `queued` —— 排着队等连接 / 等清单，旁边有「撤销」。
 *   - `sending` —— 已经发出去、回声还没到。它站在转录**里面**（见 Transcript 的
 *     `sendingRow`），三点挂在它之后；回声一到正式那条落在同一格。没有「撤销」：
 *     请求已经离手了。靠虚线边与「发送中…」说「还在路上」。
 *
 * 对齐由宿主给（`align`），与真用户消息同一个判据：手机上真消息排在尾侧，这两条
 * 跟着；桌面不传，与真消息一样在起始侧。
 */
export default function PendingSendBubble({
  text,
  images,
  onCancel,
  state = "queued",
  align,
  progress,
}: {
  text: string;
  /** 排着的这条带着的图。不摆的话它在屏幕上看着是一条纯文本消息。 */
  images?: readonly ChatImageAttachment[];
  /** 撤掉排着的那一条。`sending` 那一档不用它（已经离手，撤不回来）。 */
  onCancel?: () => void;
  state?: "queued" | "sending";
  /** 与真用户消息同一个对齐（手机 `end`）。不传 = 起始侧。 */
  align?: "start" | "end";
  /** `sending` 那一档：这一帧还在往外传（大图）。传完由宿主撤掉。 */
  progress?: UploadProgress;
}) {
  const { t } = useTranslation();
  if (state === "sending") {
    return (
      <ChatMessage
        variant="user"
        author=""
        avatar={null}
        time=""
        align={align}
        // 读屏读得到「发送中…」与那段字（无障碍那一条）。
        role="status"
        data-testid="send-sending"
      >
        {/* 虚线边：说「还在路上」。颜色取 muted-foreground —— 分隔线色一族
            （border-border）是结构线，lint 拦它，也不是这里要说的意思。 */}
        <div className="rounded-lg border border-dashed border-muted-foreground/40 px-3 py-2">
          <p className="mb-1 text-2xs font-medium text-muted-foreground">
            {t("session.sendPending.sending")}
          </p>
          {progress && <UploadRing progress={progress} />}
          <SendAttachments images={images} />
          {/* 用户自己写的那段字。动态内容，不进 t(...)。 */}
          <p className="whitespace-pre-wrap break-words text-foreground">
            {text}
          </p>
        </div>
      </ChatMessage>
    );
  }
  return (
    <ChatMessage
      variant="user"
      align={align}
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
      {/* 手机上（尾侧对齐）三种「还不是正式消息」的态与真用户消息同一形态，区别只在
          虚线边与小字（弱网规格 2026-11-20「排队态外观」），与发送中那一档同一种
          虚线、同一个非分隔线色。桌面照旧一块填充 + 时钟与那行标题（规格 2026-10-15
          「无边框改版」；弱网规格的硬约束：桌面上看得见的只改两处，这条不在其中）。 */}
      <div
        className={
          align === "end"
            ? "rounded-lg border border-dashed border-muted-foreground/40 px-3 py-2"
            : "rounded-lg bg-field-fill px-3 py-2"
        }
      >
        <p className="mb-1 flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
          <Clock3 aria-hidden="true" className="size-3 shrink-0" />
          {t("session.sendPending.title")}
        </p>
        <SendAttachments images={images} />
        {/* 用户自己写的那段字。动态内容，不进 t(...)。 */}
        <p className="whitespace-pre-wrap break-words text-foreground">
          {text}
        </p>
      </div>
    </ChatMessage>
  );
}
