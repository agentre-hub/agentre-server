import { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  MessagesSquare,
  Monitor,
  ScrollText,
  SquareTerminal,
} from "lucide-react";

import AppControls from "@/components/AppControls";
import { cn } from "@/lib/utils";

/**
 * 账号级控制台的外壳：固定 SideNav（总览 / 对话 / 设备 / 审计，决策 13）+ 主区。
 *
 * 决策 13 明确「不新增导航项」——这四项是全部，对话与审计本轮不实现具体功能
 * （块 2/块 6，非本轮目标），落成一个共享的占位区（见 WorkspaceComingSoon），
 * 而不是隐藏或禁用这两个导航项：SideNav 的形状要与设计稿一致，用户点得进去，
 * 只是里面还没有内容。
 */
const NAV_ITEMS = [
  { to: "/overview", labelKey: "nav.overview", Icon: LayoutDashboard },
  { to: "/chat", labelKey: "nav.chat", Icon: MessagesSquare },
  { to: "/devices", labelKey: "nav.devices", Icon: Monitor },
  { to: "/audit", labelKey: "nav.audit", Icon: ScrollText },
] as const;

function navLinkClassName({ isActive }: { isActive: boolean }) {
  return cn(
    "flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors",
    isActive
      ? "bg-primary-soft text-primary-text"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen bg-background">
      <nav
        aria-label={t("common.appName")}
        className="flex w-[224px] shrink-0 flex-col gap-3 border-r border-border bg-secondary p-2.5"
      >
        <div className="flex items-center gap-2 p-1.5">
          <div className="flex size-7 items-center justify-center rounded-sm bg-primary">
            <SquareTerminal
              className="size-4 text-primary-foreground"
              aria-hidden="true"
            />
          </div>
          <span className="text-[15px] font-semibold text-foreground">
            {t("authLayout.brand")}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ to, labelKey, Icon }) => (
            <NavLink key={to} to={to} className={navLinkClassName}>
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {t(labelKey)}
            </NavLink>
          ))}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end border-b border-border px-6 py-3">
          <AppControls />
        </header>
        <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
