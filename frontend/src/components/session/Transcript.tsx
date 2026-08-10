import { useTranslation } from "react-i18next";

import type { TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

/**
 * R8 转录渲染：通用形态。消息、工具调用与结果、结构化卡片都从 wire 事件帧归约而来
 * （见 lib/transcript.ts）；不识别的工具按原始形态如实呈现（raw 块），不隐藏。
 */
export default function Transcript({ items }: { items: TranscriptItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t("session.transcript.empty")}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Block key={item.id} item={item} t={t} />
      ))}
    </div>
  );
}

function Block({
  item,
  t,
}: {
  item: TranscriptItem;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  switch (item.kind) {
    case "message":
      return (
        <div
          className={cn(
            "rounded-lg border border-border px-3 py-2 text-sm",
            item.role === "user" ? "bg-card" : "bg-muted/40",
          )}
        >
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-subtle-foreground">
            <span>
              {item.role === "user"
                ? t("session.transcript.you")
                : t("session.transcript.assistant")}
            </span>
            {item.fromDevice && (
              <span className="font-normal text-status-waiting">
                {t("session.transcript.fromDevice", {
                  device: item.fromDevice,
                })}
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words text-foreground">
            {item.text}
          </p>
        </div>
      );
    case "thinking":
      return (
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm italic text-muted-foreground">
          {t("session.transcript.thinking")} {item.text}
        </p>
      );
    case "tool": {
      const label = item.toolName ?? t("session.transcript.tool");
      return (
        <div className="rounded-lg border border-border bg-code-surface px-3 py-2">
          <p className="font-mono text-xs font-semibold text-muted-foreground">
            {label}
          </p>
          {item.toolInput && item.toolInput !== "undefined" && (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-code-foreground">
              {item.toolInput}
            </pre>
          )}
          {item.result !== undefined && (
            <pre
              className={cn(
                "mt-2 border-t border-border pt-2 text-xs whitespace-pre-wrap break-words",
                item.resultIsError
                  ? "text-destructive"
                  : "text-code-muted-foreground",
              )}
            >
              {item.result}
            </pre>
          )}
        </div>
      );
    }
    case "toolResult":
      return (
        <pre
          className={cn(
            "rounded-lg border border-border bg-code-surface px-3 py-2 text-xs whitespace-pre-wrap break-words",
            item.resultIsError
              ? "text-destructive"
              : "text-code-muted-foreground",
          )}
        >
          {item.result}
        </pre>
      );
    case "error":
      return (
        <p className="rounded-lg border border-destructive bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {t("session.transcript.error")}: {item.text}
        </p>
      );
    case "decision":
      return (
        <div className="rounded-lg border border-status-waiting bg-status-waiting-bg px-3 py-2 text-sm text-status-waiting">
          {item.toolName
            ? t("session.decision.approveTool", { tool: item.toolName })
            : t("session.decision.askQuestion")}
        </div>
      );
    case "turnDone":
      return <hr aria-hidden="true" className="border-border/60" />;
    case "raw":
    default:
      // 不识别的工具按原始形态如实呈现，不隐藏（R8）。
      return (
        <div className="rounded-lg border border-border bg-code-surface px-3 py-2">
          <p className="mb-1 font-mono text-xs font-semibold text-subtle-foreground">
            {t("session.transcript.unknownEvent")}
            {item.eventKind ? ` · ${item.eventKind}` : ""}
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-code-foreground">
            {JSON.stringify(item.raw, null, 2)}
          </pre>
        </div>
      );
  }
}
