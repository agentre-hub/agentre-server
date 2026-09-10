import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@agentre-hub/agentre-ui";

/**
 * 通用空态（Pencil 正式空态画板提炼）。
 *
 * 只保留重复的信息层级：62px 图标圈（brand/warn 两种语义底色）+ 标题 +
 * 正文 + 可选动作。不带画板里的机器清单/CTA 讲解等页面特有内容——
 * 那是各页面用真实数据拼装的部分。无数据源的区块必须给诚实空态，
 * 禁止编数字或示例。
 */
export function EmptyState({
  icon: Icon,
  tone = "brand",
  title,
  body,
  action,
  testId,
}: {
  icon: LucideIcon;
  tone?: "brand" | "warn";
  title: string;
  body?: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-3.5 px-4 py-6 text-center"
    >
      <div
        data-testid="empty-icon"
        className={cn(
          "flex size-[62px] shrink-0 items-center justify-center rounded-full",
          tone === "warn"
            ? "bg-status-waiting-bg text-status-waiting"
            : "bg-primary-soft text-primary-text",
        )}
      >
        <Icon className="size-7" aria-hidden="true" />
      </div>
      <p className="text-lg font-bold text-foreground">{title}</p>
      {body ? (
        <p className="max-w-sm text-[12.5px] leading-[22px] text-muted-foreground">
          {body}
        </p>
      ) : null}
      {action}
    </div>
  );
}
