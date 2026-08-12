import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 统计项（Pencil 总览 IhldU 统计卡提炼）。
 *
 * 尺寸契约：label 11.5px + 13px 图标、value 23px bold、unit 12px、
 * sub 10.5px；圆角 md、padding 14/12。danger tone 把整套换成 destructive
 * 语义 token（无数据源区块用 value="—" 的诚实空态，不编数字）。
 */
export function Metric({
  label,
  value,
  unit,
  sub,
  icon: Icon,
  tone = "default",
  testId,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string | null;
  icon?: LucideIcon;
  tone?: "default" | "danger";
  testId?: string;
}) {
  const danger = tone === "danger";
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border px-3.5 py-3",
        danger
          ? "border-destructive bg-destructive-soft"
          : "border-border bg-card",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5",
          danger ? "text-destructive" : "text-subtle-foreground",
        )}
      >
        {Icon ? (
          <Icon className="size-[13px] shrink-0" aria-hidden="true" />
        ) : null}
        <span className="truncate text-[11.5px]">{label}</span>
      </div>
      <div className="flex items-end gap-1.5">
        <span
          data-testid="metric-value"
          className={cn(
            "text-[23px] leading-none font-bold",
            danger ? "text-destructive" : "text-foreground",
          )}
        >
          {value}
        </span>
        {unit ? (
          <span
            data-testid="metric-unit"
            className="text-xs text-subtle-foreground"
          >
            {unit}
          </span>
        ) : null}
      </div>
      {sub ? (
        <span
          data-testid="metric-sub"
          className={cn(
            "truncate text-[10.5px]",
            danger ? "text-destructive" : "text-subtle-foreground",
          )}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}
