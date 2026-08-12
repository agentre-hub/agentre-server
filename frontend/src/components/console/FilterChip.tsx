import { cn } from "@/lib/utils";

/**
 * 筛选项（Pencil 正式组件 rNQXR FilterChip）。
 *
 * 形状：h-[22px] rounded-full、11px 文案、secondary 面；active 换
 * primary-soft/primary-text。disabled = 无真实筛选能力时的诚实表达：
 * 不是按钮、aria-disabled、不进焦点序、点不动——不冒充可用的假开关。
 */
export function FilterChip({
  label,
  active = false,
  disabled = false,
  onClick,
  testId,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  if (disabled) {
    return (
      <span
        data-testid={testId}
        aria-disabled="true"
        className="inline-flex h-[22px] cursor-not-allowed items-center rounded-full bg-secondary px-[9px] text-[11px] font-medium text-subtle-foreground opacity-60"
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-[22px] items-center rounded-full px-[9px] text-[11px] font-medium transition-colors",
        active
          ? "bg-primary-soft text-primary-text"
          : "bg-secondary text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}
