import { createContext, useContext, type ReactNode } from "react";
import { ChevronLeft, Menu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  cn,
} from "@agentre-hub/agentre-ui";

/**
 * 手机外壳的导航件（规格 2026-11-05 手机 PWA「外壳与导航」）：左抽屉取代底部 TabBar。
 *
 * 抽屉的开合状态由 AppShell 持有，经这里的 context 递给页头上的 ☰：自己画页头的页
 * （对话列表、对话页）同样用 `MobileNavButton`，不必各自再造一个开关。
 */
const MobileDrawerContext = createContext<{ open: () => void } | null>(null);

export const MobileDrawerProvider = MobileDrawerContext.Provider;

/** 手机顶层页：页头左侧是 ☰。其余（对话、Agent 详情等）是返回。 */
const TOP_LEVEL_PATHS = new Set([
  "/overview",
  "/chat",
  "/issues",
  "/org",
  "/devices",
  "/settings",
  "/account",
]);

export function isTopLevelPath(pathname: string): boolean {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return TOP_LEVEL_PATHS.has(normalized);
}

/** 没有可退的历史（直接打开深链、PWA 冷启动）时，返回落到它所属的顶层页。 */
function parentOf(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0];
  return first ? `/${first}` : "/";
}

const BUTTON_CLASS =
  "relative -ml-2 flex size-11 shrink-0 items-center justify-center rounded-md text-foreground outline-none hover:bg-rail-accent focus-visible:focus-outline";

/** 页头左侧：顶层页 ☰（开抽屉），非顶层页返回。命中区 44px。 */
export function MobileNavButton() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const drawer = useContext(MobileDrawerContext);

  if (isTopLevelPath(pathname) && drawer) {
    return (
      <button
        type="button"
        aria-label={t("appShell.drawer.open")}
        onClick={drawer.open}
        className={BUTTON_CLASS}
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={t("appShell.drawer.back")}
      onClick={() => {
        // react-router 在内存历史与浏览器历史里都在 state.idx 记着自己的位置；
        // 0 表示这一页就是入口，navigate(-1) 会把人带出本站。
        const idx = (window.history.state as { idx?: number } | null)?.idx;
        if (typeof idx === "number" && idx > 0) navigate(-1);
        else navigate(parentOf(pathname), { replace: true });
      }}
      className={BUTTON_CLASS}
    >
      <ChevronLeft className="size-6" aria-hidden="true" />
    </button>
  );
}

export interface MobileDrawerAccount {
  name: string;
  email: string;
}

/**
 * 左抽屉：宽 84%、最宽 320px，从左滑入 220ms ease-out；遮罩可点关。
 * 动画只在 motion-safe 下挂，「减弱动态效果」时直接出现。
 *
 * 用共享包的 Dialog 当底座（焦点陷阱、Escape、遮罩点击都是它的），这里只换定位。
 * 内容由 AppShell 摆（导航项要它手里的角标与设备数），点到任一链接即关：
 * 外层 onClick 接住冒泡上来的链接点击。
 */
export function MobileDrawer({
  open,
  onOpenChange,
  title,
  account,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  account: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) onOpenChange(false);
        }}
        className={cn(
          "left-0 top-0 h-dvh w-[84%] max-w-[320px] translate-x-0 translate-y-0 rounded-none rounded-r-xl bg-chrome",
          "flex flex-col gap-3 p-3 pt-[calc(12px_+_env(safe-area-inset-top,0px))] pb-[calc(12px_+_env(safe-area-inset-bottom,0px))]",
          "duration-[220ms] ease-out",
          "motion-safe:data-[state=open]:slide-in-from-left motion-safe:data-[state=closed]:slide-out-to-left",
          "motion-safe:data-[state=open]:slide-in-from-top-0 motion-safe:data-[state=closed]:slide-out-to-top-0",
          "motion-safe:data-[state=open]:zoom-in-100 motion-safe:data-[state=closed]:zoom-out-100",
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {account}
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** 抽屉里的分组小标题。 */
export function DrawerSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

/** 抽屉顶部的账号区：头像 + 名字 + 邮箱，整块点进账号页。 */
export function DrawerAccount({ name, email }: MobileDrawerAccount) {
  return (
    <Link
      to="/account"
      className="flex min-h-[52px] items-center gap-3 rounded-md px-2 hover:bg-rail-accent focus-visible:focus-outline outline-none"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text">
        {name.charAt(0)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-aux font-semibold text-foreground">
          {name}
        </span>
        <span className="block truncate text-3xs text-muted-foreground">
          {email}
        </span>
      </span>
    </Link>
  );
}
