import type { LucideIcon } from "lucide-react";

/**
 * 统计项（Pencil 总览 IhldU 统计卡提炼）。
 *
 * 尺寸契约：label 11.5px + 13px 图标、value 23px bold、unit 12px、
 * sub 10.5px；圆角 md、padding 14/12（无数据源区块用 value="—" 的诚实空态，
 * 不编数字）。
 *
 * 是一块填充，不画边：`bg-field-fill` 相对脚下的面压暗一档，落在内容页或另一块
 * 填充卡上都分得开（弱化文字由填充工具类自己换成 fill-muted-foreground）。
 */
export function Metric({
  label,
  value,
  unit,
  sub,
  icon: Icon,
  testId,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string | null;
  icon?: LucideIcon;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 flex-col gap-1.5 rounded-md bg-field-fill px-3.5 py-3"
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {Icon ? (
          <Icon className="size-[13px] shrink-0" aria-hidden="true" />
        ) : null}
        <span className="truncate text-[11.5px]">{label}</span>
      </div>
      <div className="flex items-end gap-1.5">
        <span
          data-testid="metric-value"
          className="text-[23px] leading-none font-bold text-foreground"
        >
          {value}
        </span>
        {unit ? (
          <span
            data-testid="metric-unit"
            className="text-xs text-muted-foreground"
          >
            {unit}
          </span>
        ) : null}
      </div>
      {sub ? (
        <span
          data-testid="metric-sub"
          className="truncate text-[10.5px] text-muted-foreground"
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}
