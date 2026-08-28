import {
  ChevronsUpDown,
  LogOut,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@agentre-hub/agentre-ui";
import type { Me } from "@/hooks/use-me";
import { api } from "@/lib/api";

/**
 * 账号块 = 下拉菜单触发器（规格「用户菜单与 /account」菜单段）：桌面侧栏左下
 * 与移动端 TopBar 共用同一个组件，只是 compact 形态收起名字/邮箱副行。
 *
 * 菜单包含账号信息（显示名 + 邮箱，只读，不可聚焦）、「账号与安全」
 * （去 /account）、「设置」（去 /settings）与「登出」（真调用 POST /v1/auth/logout，
 * 无论成败都落地登录页——会话多半已经失效，留在原地才是假象）。
 *
 * 调用方负责「账号数据取不到就不渲染」：本组件要求 me 非空，不在内部伪造
 * 头像或名字。
 */
export function UserMenu({
  me,
  compact = false,
}: {
  me: Me;
  compact?: boolean;
}) {
  const { t } = useTranslation();

  const handleLogout = () => {
    // 无论端点调用成败都落地登录页：会话大概率已经失效，留在受保护页面上
    // 假装还登录着才是真正的假象。catch 吞掉失败，避免留下未处理的 rejection。
    void api("/v1/auth/logout", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        window.location.assign("/login");
      });
  };

  const avatar = (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text">
      {me.display_name.charAt(0)}
    </div>
  );

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={t("appShell.userMenu.trigger")}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "hover:bg-accent data-[state=open]:bg-accent",
          compact ? "px-1 py-1" : "h-[42px] w-full px-1.5",
        )}
      >
        {avatar}
        {compact ? (
          // 紧凑形态延续原移动 TopBar 账号块的做法（AppShell.tsx 原 mobileAccount）：
          // 名字随 DOM 一起渲染，只在 ≥sm 断点显示——390 宽的手机上只剩头像，
          // 与 mockups/shots/mobile-menu.png 一致。
          <span className="hidden max-w-[96px] truncate text-xs font-semibold text-foreground sm:inline">
            {me.display_name}
          </span>
        ) : (
          <>
            <div className="min-w-0 flex-1 text-left">
              <div className="truncate text-xs font-semibold text-foreground">
                {me.display_name}
              </div>
              <div className="truncate text-3xs text-muted-foreground">
                {me.email}
              </div>
            </div>
            <ChevronsUpDown
              className="size-3.5 shrink-0 text-decorative-foreground"
              aria-hidden="true"
            />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side={compact ? "bottom" : "top"}
        align={compact ? "end" : "start"}
      >
        {/* 账号信息是只读的一段，不是菜单项：不可聚焦、不可点。 */}
        <DropdownMenuLabel>
          <div className="truncate text-xs font-semibold text-foreground">
            {me.display_name}
          </div>
          <div className="truncate text-2xs text-muted-foreground">
            {me.email}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <ShieldCheck
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("appShell.userMenu.account")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <SettingsIcon
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("appShell.userMenu.settings")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleLogout}>
          <LogOut className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("appShell.userMenu.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
