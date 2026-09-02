import { NavLink } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

import { cn } from "@agentre-hub/agentre-ui";

/**
 * 控制台导航项（Pencil 正式组件 ZC7pI NavItem）。
 *
 * 尺寸契约：h-[34px] rounded-md px-2.5、17px 图标、13px 文案。
 * 状态：active = primary-soft 面 + primary-text；idle = muted +
 * hover accent。尾部数据按需出现、全部诚实：badge 只在 >0 时渲染，
 * meta/dot 由调用方在拿到真实数据后才传。不渲染就不会谎报。
 *
 * `collapsed` 是 56px 图标栏那一档（外壳的侧栏可以收起）。收窄改的是**排布**，
 * 不是这一项还剩多少信息：
 *   - 文案退成 sr-only 而不是删掉——图标不是名字，链接的可访问名不能因为
 *     视觉上收窄就没了；
 *   - badge 挪到图标角上：它是这条栏上唯一会变的东西，收窄不该把它变没；
 *   - meta（设备在线/全部）进 title：一行 mono 数字在 56px 里排不下，
 *     但「丢掉」和「换个地方说」是两回事。
 */
export function ConsoleNavItem({
  to,
  label,
  Icon,
  badge,
  meta,
  dot,
  collapsed = false,
  onClick,
}: {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** 账号里已保存的对话数：>0 才渲染琥珀徽标。 */
  badge?: number | null;
  /** 设备在线/全部等 mono 元信息。 */
  meta?: string | null;
  /** 未读/告警圆点，仅在有真实数据时传入。 */
  dot?: boolean;
  /** 56px 图标栏形态：只留图标，其余信息各自换个位置。 */
  collapsed?: boolean;
  onClick?: () => void;
}) {
  const hasBadge = typeof badge === "number" && badge > 0;

  return (
    <NavLink
      to={to}
      onClick={onClick}
      // 收起后鼠标停上去才说得出这是哪一项；展开时文案就在旁边，再挂一个
      // title 只会在光标下重复一遍。
      title={collapsed ? [label, meta].filter(Boolean).join(" ") : undefined}
      className={navItemClass(collapsed)}
    >
      <Icon className="size-[17px] shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-aux font-medium",
          collapsed && "sr-only",
        )}
      >
        {label}
      </span>
      {hasBadge ? (
        <span
          className={cn(
            "flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-status-waiting px-1.5 text-3xs font-semibold text-status-waiting-foreground",
            collapsed && "absolute right-0.5 top-0 h-[15px] min-w-[15px] px-1",
          )}
        >
          {badge}
        </span>
      ) : null}
      {meta && !collapsed ? (
        <span className="shrink-0 font-mono text-3xs font-semibold text-muted-foreground">
          {meta}
        </span>
      ) : null}
      {dot ? (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-primary",
            collapsed && "absolute right-1 top-1",
          )}
        />
      ) : null}
    </NavLink>
  );
}

function navItemClass(collapsed: boolean) {
  return ({ isActive }: { isActive: boolean }) =>
    cn(
      "relative flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-md transition-colors",
      collapsed ? "justify-center px-0" : "px-2.5",
      isActive
        ? "bg-primary-soft text-primary-text"
        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    );
}
