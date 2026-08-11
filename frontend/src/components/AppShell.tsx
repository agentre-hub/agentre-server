import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Monitor,
  ScrollText,
  SquareTerminal,
  X,
} from "lucide-react";

import AppControls from "@/components/AppControls";
import { useIsMobile } from "@/components/use-is-mobile";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 账号级控制台的外壳：固定 SideNav（总览 / 对话 / 设备 / 审计，决策 13）+ 主区。
 *
 * 决策 13 明确「不新增导航项」——这四项是全部。桌面是固定左侧栏；移动（≤767px）
 * 换成顶栏汉堡按钮 + 左侧抽屉（设计稿屏 29），同一份导航项、同一份文案。
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
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const brand = (
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
  );

  const navItems = (
    <div className="flex flex-col gap-0.5">
      {NAV_ITEMS.map(({ to, labelKey, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={navLinkClassName}
          onClick={isMobile ? () => setDrawerOpen(false) : undefined}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {t(labelKey)}
        </NavLink>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {!isMobile && (
        <nav
          aria-label={t("common.appName")}
          className="flex w-[224px] shrink-0 flex-col gap-3 border-r border-border bg-secondary p-2.5"
        >
          {brand}
          {navItems}
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3 md:px-6">
          {isMobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-10"
              aria-label={t("nav.openMenu")}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Menu className="size-5" aria-hidden="true" />
            </Button>
          )}
          <span className="flex-1" />
          <AppControls />
        </header>
        <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-6">
          {children}
        </main>
      </div>

      {/* 移动端导航抽屉（设计稿屏 29）。开/关都销毁节点，避免隐藏内容留在
          焦点序里；状态经 aria-expanded 暴露在汉堡按钮上。 */}
      {isMobile && drawerOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label={t("nav.closeMenu")}
            className="absolute inset-0 bg-scrim"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("nav.drawer")}
            className="absolute inset-y-0 left-0 flex w-[280px] max-w-[80vw] flex-col gap-3 border-r border-border bg-secondary p-2.5 shadow-overlay"
          >
            <div className="flex items-center gap-2 p-1.5">
              {brand}
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-10"
                aria-label={t("nav.closeMenu")}
                onClick={() => setDrawerOpen(false)}
              >
                <X className="size-5" aria-hidden="true" />
              </Button>
            </div>
            {navItems}
            <div className="mt-auto flex justify-end px-1.5 pb-1.5">
              <AppControls />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
