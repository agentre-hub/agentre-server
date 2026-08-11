import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Monitor,
  ScrollText,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";

import AppControls from "@/components/AppControls";
import { useIsMobile } from "@/components/use-is-mobile";
import { Button } from "@/components/ui/button";
import { useMe } from "@/hooks/use-me";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** ⌘K 是快捷键符号，不是界面文案，不走 t()。 */
const CMD_KBD = "\u2318K";

/** /v1/follows 的关注条目；对话 Badge 只取总数。 */
interface FollowItem {
  device_fingerprint: string;
  session_id: string;
}

/** /v1/devices 只取算设备 Meta 需要的字段。 */
interface DeviceRow {
  id: number;
  kind: string;
  online: boolean;
}

interface DeviceMeta {
  online: number;
  total: number;
}

interface NavItem {
  to: string;
  labelKey: string;
  Icon: typeof LayoutDashboard;
  /** 对话：关注数（有值且 >0 才渲染 Badge）。 */
  badge?: number | null;
  /** 设备：agentred 在线/全部（取到才渲染 Meta）。 */
  meta?: DeviceMeta | null;
  /** 审计：常驻蓝点。 */
  dot?: boolean;
}

/**
 * 账号级控制台的外壳：224px SideNav（Brand / ⌘K 搜索框 / 4 导航项 / 账号区）
 * + 52px TopBar（title 槽 + right 槽 + AppControls）+ 主区。
 *
 * 决策 13 明确「不新增导航项」——总览/对话/设备/审计是全部。桌面是固定左侧栏；
 * 移动（≤767px）换成顶栏汉堡按钮 + 左侧抽屉（设计稿屏 29），同一份导航项、同一份文案。
 *
 * title / right 可选（向后兼容）：不传时 TopBar 左侧空、右侧仍渲染 AppControls。
 * 导航项尾部数据（对话关注数 Badge、设备在线/全部 Meta、账号区）都是锦上添花：
 * 取不到就隐藏对应元素，绝不阻塞整体渲染。
 */
export default function AppShell({
  title,
  right,
  children,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { me } = useMe();
  const [followCount, setFollowCount] = useState<number | null>(null);
  const [deviceMeta, setDeviceMeta] = useState<DeviceMeta | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ items: FollowItem[] }>("/v1/follows")
      .then((res) => {
        if (alive) setFollowCount(res.items?.length ?? 0);
      })
      .catch(() => {});
    api<{ devices: DeviceRow[] }>("/v1/devices")
      .then((res) => {
        if (!alive) return;
        const agents = (res.devices ?? []).filter((d) => d.kind === "agentred");
        setDeviceMeta({
          online: agents.filter((a) => a.online).length,
          total: agents.length,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const NAV_ITEMS: NavItem[] = [
    { to: "/overview", labelKey: "nav.overview", Icon: LayoutDashboard },
    {
      to: "/chat",
      labelKey: "nav.chat",
      Icon: MessagesSquare,
      badge: followCount,
    },
    {
      to: "/devices",
      labelKey: "nav.devices",
      Icon: Monitor,
      meta: deviceMeta,
    },
    { to: "/audit", labelKey: "nav.audit", Icon: ScrollText, dot: true },
  ];

  const brand = (
    <div className="flex items-center gap-2 p-1.5">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary">
        <SquareTerminal
          className="size-4 text-primary-foreground"
          aria-hidden="true"
        />
      </div>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[15px] font-semibold text-foreground">
          {t("authLayout.brand")}
        </span>
        <span className="text-[10px] text-subtle-foreground">
          {t("appShell.productSub")}
        </span>
      </div>
    </div>
  );

  const cmdBtn = (
    <button
      type="button"
      aria-label={t("appShell.searchPlaceholder")}
      className="flex h-8 w-full items-center gap-[7px] rounded-md border border-border bg-card px-2.5 text-left"
    >
      <Search
        className="size-[13px] shrink-0 text-subtle-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
        {t("appShell.searchPlaceholder")}
      </span>
      <kbd className="shrink-0 font-mono text-[10px] text-subtle-foreground">
        {CMD_KBD}
      </kbd>
    </button>
  );

  const navItems = (
    <div className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const { to, labelKey, Icon } = item;
        return (
          <NavLink
            key={to}
            to={to}
            className={navLinkClassName}
            onClick={isMobile ? () => setDrawerOpen(false) : undefined}
          >
            <Icon className="size-[17px] shrink-0" aria-hidden="true" />
            {t(labelKey)}
            {navTrailing(item)}
          </NavLink>
        );
      })}
    </div>
  );

  // 账号数据取不到就整行隐藏，不伪造头像/名字。
  const account = me ? (
    <div className="flex h-[42px] items-center gap-2 rounded-md px-1.5">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text">
        {me.display_name.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-foreground">
          {me.display_name}
        </div>
        <div className="truncate text-[10px] text-subtle-foreground">
          {t("appShell.accountMeta")}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex min-h-screen bg-background">
      {!isMobile && (
        <nav
          aria-label={t("common.appName")}
          className="flex w-[224px] shrink-0 flex-col gap-3 border-r border-border bg-sidebar p-3"
        >
          {brand}
          {cmdBtn}
          {navItems}
          <div className="flex-1" />
          <div className="border-t border-border" />
          {account}
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] items-center gap-3 border-b border-border bg-card px-4">
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
          {title ? (
            <span className="truncate text-[15px] font-bold text-foreground">
              {title}
            </span>
          ) : null}
          <span className="flex-1" />
          {right}
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
            className="absolute inset-y-0 left-0 flex w-[280px] max-w-[80vw] flex-col gap-3 border-r border-border bg-sidebar p-3 shadow-overlay"
          >
            <div className="flex items-center gap-2">
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
            {cmdBtn}
            {navItems}
            <div className="flex-1" />
            <div className="border-t border-border" />
            <div className="flex items-center gap-2">
              {account}
              <div className="flex-1" />
              <AppControls />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function navLinkClassName({ isActive }: { isActive: boolean }) {
  return cn(
    "flex h-[34px] w-full shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
    isActive
      ? "bg-primary-soft text-primary-text"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  );
}

function navTrailing(item: NavItem): ReactNode {
  if (item.badge !== undefined && item.badge !== null && item.badge > 0) {
    return (
      <span className="ml-auto flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-status-waiting px-1.5 text-[10px] font-semibold text-status-waiting-foreground">
        {item.badge}
      </span>
    );
  }
  if (item.meta) {
    return (
      <span className="ml-auto font-mono text-[10px] text-subtle-foreground">
        {item.meta.online}/{item.meta.total}
      </span>
    );
  }
  if (item.dot) {
    return (
      <span
        className="ml-auto size-1.5 rounded-full bg-primary"
        aria-hidden="true"
      />
    );
  }
  return null;
}
