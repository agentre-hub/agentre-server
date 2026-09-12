import { NavLink } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

import { NavBadge } from "@/components/console/NavBadge";
import { cn } from "@agentre-hub/agentre-ui";

/**
 * 移动端底部导航（Pencil 正式组件 A6Z3k TabBar）。
 *
 * 只承载真实可达的目的地：items 由外壳传入（不伪造「我」等占位入口）。
 * 形状：h-[74px] bg-card + 顶边框、图标 21px + 文案 10px；
 * active = primary-text + 600，idle = subtle + 500。
 */
export interface MobileTab {
  key: string;
  to: string;
  label: string;
  Icon: LucideIcon;
  /**
   * 需要你的对话条数：>0 才画，null / undefined = 还没取到（同样不画）。
   *
   * 与侧栏 `ConsoleNavItem` 的那颗**同一个数**。此前外壳派生移动 tabs 时把它丢了，
   * 窄屏上因此完全看不到有多少条在等你——而底部这条栏就是移动端的主导航。
   */
  badge?: number | null;
  /** 那个数是怎么来的（「N 条等你处理 · M 条未读」）。角标只有一个数字位，
   * 拆开的说明落在 title 与读屏文字上。 */
  badgeLabel?: string | null;
}

export function MobileTabBar({
  items,
  ariaLabel,
}: {
  items: MobileTab[];
  ariaLabel?: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="flex h-[74px] items-stretch border-t border-border bg-card pb-[14px] pt-2"
    >
      {items.map((item) => (
        <NavLink
          key={item.key}
          to={item.to}
          className={({ isActive }) =>
            cn(
              "flex min-w-0 flex-1 flex-col items-center justify-center gap-[3px]",
              isActive ? "text-primary-text" : "text-muted-foreground",
            )
          }
        >
          {({ isActive }) => (
            <>
              <span className="relative flex shrink-0">
                <item.Icon className="size-[21px]" aria-hidden="true" />
                <NavBadge
                  count={item.badge}
                  label={item.badgeLabel}
                  className="absolute -right-2 -top-1 h-[15px] min-w-[15px] px-1"
                />
              </span>
              <span
                className={cn(
                  "text-3xs",
                  isActive ? "font-semibold" : "font-medium",
                )}
              >
                {item.label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
