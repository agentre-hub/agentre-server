import { CircleAlert, Copy, RotateCw, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, ChatMessage } from "@agentre-hub/agentre-ui";
import type { SendFailureKind } from "@/lib/sessionView";

/**
 * 一条没发出去的消息（规格 2026-08-21 决策 7）。
 *
 * 它取代的是输入框下沿那行 11px 小红字。三处不同：
 *
 *  1. **用户写的字留在屏幕上**，复制得走。此前 `AIChatInput` 在提交时就把输入
 *     清空了（`composerText()` 断言的就是这件事），而文案却说「草稿已保留」——
 *     那句话是假的。
 *  2. **按分类给不同的主动作。** `classifySendFailure` 早就分出了 transport 与
 *     rejected，而 `sessionView.ts` 的注释写明 transport **不能**直接重发：请求
 *     可能已经送达，重发会多出一条消息。此前两类共用一句「…请重试」。
 *  3. 它站在转录流里，跟别的消息同一个位置——那条消息本来就属于那里。
 *
 * 「同一个位置」这一条现在是**真的**了：外壳换成共享包的 `ChatMessage
 * variant="user"`，与转录里一条真用户消息同一个组件——同样的「我」头像、同样的
 * 行首对齐。此前它虽然站在流里，却是一枚右对齐气泡（`max-w-[84%] self-end`），
 * 而包的转录里一条消息都不贴右；「没发出去的那句」与「发出去了的那句」因此在同
 * 一列里长得不是一个东西。换的只有外壳，下面三类的分工一个字没动。
 *
 * `executionUnavailable` 不走这里：它已经有自己的横幅（B 档），再来一个气泡就是
 * 同一件事说两遍。
 */
export interface FailedSend {
  id: string;
  text: string;
  /**
   * `executionUnavailable` 由横幅承接，不进这里。
   *
   * `notSent` 不来自 `classifySendFailure`：它是**一次请求都没发出去**——重连期间
   * 排着队、而连接最后彻底断了（决策 6）。与 `transport` 分开是要紧的：那一类
   * 「可能已经送达」，这一类明确没有，所以重发是干净的。
   */
  kind: Exclude<SendFailureKind, "executionUnavailable"> | "notSent";
  /** 对端自己的说明（仅 rejected 有），它已按自己的语言本地化过。 */
  detail?: string;
}

export default function SendFailureBubble({
  failure,
  machineName,
  busy,
  onRetry,
  onDiscard,
}: {
  failure: FailedSend;
  machineName?: string;
  busy?: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  // 只有 transport 那一类要先看一眼：另外两类都没走到对端，重发是干净的。
  const transport = failure.kind === "transport";
  const Icon =
    transport || failure.kind === "notSent" ? CircleAlert : TriangleAlert;

  const title =
    machineName && failure.kind !== "notSent"
      ? t(`session.sendFailure.${failure.kind}.title`, { machine: machineName })
      : t(`session.sendFailure.${failure.kind}.titleUnknown`);

  return (
    <ChatMessage
      variant="user"
      // author / avatar 在 user 档上不被使用（包自己画中性的「我」），类型上必填。
      author=""
      avatar={null}
      // 没发出去，也就没有「什么时候发的」。不编一个时刻。
      time=""
      role="alert"
      data-testid="send-failure"
      data-failure-kind={failure.kind}
      // 外层**不吃** padding/border：它们会把整行（含头像）一起往右推，「我」那
      // 一列就与相邻的真消息错开一格 —— 而这一轮要的正是同一列。记号落在正文
      // 那一列里（见下面的包裹层）。
      className="py-0.5"
      meta={
        <div className="flex flex-wrap gap-1.5">
          {/* transport 的主动作是「检查后重发」而不是「重发」：先补一次转录，
              确认那条到底有没有落地。默认动作不该是一个可能发出两条的操作。 */}
          <Button
            size="xs"
            variant={transport ? "outline" : "default"}
            data-testid="send-failure-retry"
            disabled={busy}
            onClick={onRetry}
          >
            <RotateCw aria-hidden="true" className="size-3" />
            {t(
              transport
                ? "session.sendFailure.recheck"
                : "session.sendFailure.resend",
            )}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            data-testid="send-failure-copy"
            onClick={() => void navigator.clipboard?.writeText(failure.text)}
          >
            <Copy aria-hidden="true" className="size-3" />
            {t("session.sendFailure.copy")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            data-testid="send-failure-discard"
            onClick={onDiscard}
          >
            <X aria-hidden="true" className="size-3" />
            {t("session.sendFailure.discard")}
          </Button>
        </div>
      }
    >
      {/* 红底只占正文这一列，不把头像一起圈进去。 */}
      <div className="rounded-lg border border-destructive/45 bg-destructive-soft px-3 py-2">
        <p className="mb-1 flex items-center gap-1.5 text-2xs font-semibold text-destructive-text">
          <Icon aria-hidden="true" className="size-3 shrink-0" />
          {title}
        </p>
        {/* 用户自己写的那段字。动态内容，不进 t(...)。 */}
        <p className="whitespace-pre-wrap break-words text-foreground">
          {failure.text}
        </p>
        <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
          {transport ? (
            t("session.sendFailure.transport.body")
          ) : failure.kind === "notSent" ? (
            t("session.sendFailure.notSent.body")
          ) : failure.detail ? (
            // 「它说：」标出这是**那台机器的原话**，不是本站的判断。对端已经按它
            // 自己的语言本地化过，原样转述，不替换成我们编的故事。
            <>
              {t("session.sendFailure.rejected.said")}
              <span className="text-foreground">{failure.detail}</span>
            </>
          ) : (
            t("session.sendFailure.rejected.body")
          )}
        </p>
      </div>
    </ChatMessage>
  );
}
