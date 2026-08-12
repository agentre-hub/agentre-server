import { NavLink } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 控制台导航项（Pencil 正式组件 ZC7pI NavItem）。
 *
 * 尺寸契约：h-[34px] rounded-md px-2.5、17px 图标、13px 文案。
 * 状态：active = primary-soft 面 + primary-text；idle = muted +
 * hover accent。尾部数据按需出现、全部诚实：badge 只在 >0 时渲染，
 * meta/dot 由调用方在拿到真实数据后才传。不渲染就不会谎报。
 */
export function ConsoleNavItem({
  to,
  label,
  Icon,
  badge,
  meta,
  dot,
  onClick,
}: {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** 对话关注数：>0 才渲染琥珀徽标。 */
  badge?: number | null;
  /** 设备在线/全部等 mono 元信息。 */
  meta?: string | null;
  /** 审计蓝点。 */
  dot?: boolean;
  onClick?: () => void;
}) {
  return (
    <NavLink to={to} onClick={onClick} className={navItemClass}>
      <Icon className="size-[17px] shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
        {label}
      </span>
      {typeof badge === "number" && badge > 0 ? (
        <span className="flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-status-waiting px-1.5 text-[10px] font-semibold text-status-waiting-foreground">
          {badge}
        </span>
      ) : null}
      {meta ? (
        <span className="shrink-0 font-mono text-[10px] font-semibold text-subtle-foreground">
          {meta}
        </span>
      ) : null}
      {dot ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
    </NavLink>
  );
}

function navItemClass({ isActive }: { isActive: boolean }) {
  return cn(
    "flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-md px-2.5 transition-colors",
    isActive
      ? "bg-primary-soft text-primary-text"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  );
}
