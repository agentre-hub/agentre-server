import { cn } from "@/lib/utils";

/**
 * 状态标记（Pencil 正式组件 zF5jv StatusPill）。
 *
 * 形状：圆角胶囊 = 装饰点 + 文案，两者同色。文案永远是可见文本节点——
 * 颜色不是状态的唯一表达。tone 只映射到已声明的语义 token，深浅色都从
 * token 来，不写字面色值。
 */
export type StatusTone = "running" | "waiting" | "idle" | "error";

const TONE_CLASS: Record<StatusTone, string> = {
  running: "bg-status-running-bg text-status-running",
  waiting: "bg-status-waiting-bg text-status-waiting",
  idle: "bg-secondary text-status-idle",
  error: "bg-destructive-soft text-destructive",
};

export function StatusMark({
  tone,
  label,
  testId,
}: {
  tone: StatusTone;
  /** 状态文案（页面经 t() 传入，组件不持有任何产品文案）。 */
  label: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px]",
        TONE_CLASS[tone],
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      <span className="text-xs font-semibold">{label}</span>
    </span>
  );
}
