import { NavLink } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

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
              <item.Icon className="size-[21px]" aria-hidden="true" />
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
