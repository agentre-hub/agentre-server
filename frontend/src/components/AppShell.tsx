import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  MessagesSquare,
  Monitor,
  ScrollText,
  Search,
  SquareTerminal,
} from "lucide-react";

import AppControls from "@/components/AppControls";
import { ConsoleNavItem } from "@/components/console";
import { MobileTabBar, type MobileTab } from "@/components/console";
import { useIsMobile } from "@/components/use-is-mobile";
import { useMe } from "@/hooks/use-me";
import { api } from "@/lib/api";

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
}

/**
 * 账号级控制台的外壳：桌面固定 224px SideNav（R969Y：Brand / 非交互搜索外观 /
 * 4 导航项 / 账号区）+ 52px TopBar（title 槽 + right 槽 + AppControls）+ 主区；
 * 移动（≤767px）主导航改为 A6Z3k 底部 TabBar（只含真实目的地），账号进 TopBar。
 *
 * 搜索无真实能力：外观保留但不可聚焦（div + aria-hidden，无 button/input/tabindex），
 * 也不显示 ⌘K 快捷键暗示。审计没有真实数据，nav 项不渲染伪蓝点。
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

  // 审计无真实后端数据，不传 dot —— 不渲染就不会谎报新事件。
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
    { to: "/audit", labelKey: "nav.audit", Icon: ScrollText },
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

  // 无真实搜索能力：保留搜索外观，但它是纯展示 —— 不可聚焦、无 button 语义、
  // 不显示快捷键，读屏也跳过（不冒充可用控件）。
  const searchBox = (
    <div
      aria-hidden="true"
      className="flex h-8 w-full items-center gap-[7px] rounded-md border border-border bg-card px-2.5"
    >
      <Search
        className="size-[13px] shrink-0 text-subtle-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
        {t("appShell.searchPlaceholder")}
      </span>
    </div>
  );

  const navItems = (
    <div className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => (
        <ConsoleNavItem
          key={item.to}
          to={item.to}
          label={t(item.labelKey)}
          Icon={item.Icon}
          badge={item.badge}
          meta={item.meta ? `${item.meta.online}/${item.meta.total}` : null}
        />
      ))}
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

  // 移动端账号进 TopBar：抽屉已移除，账号仍需可达。
  const mobileAccount = me ? (
    <div className="flex items-center gap-2" title={me.display_name}>
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text">
        {me.display_name.charAt(0)}
      </div>
      <span className="hidden max-w-[96px] truncate text-xs font-semibold text-foreground sm:inline">
        {me.display_name}
      </span>
    </div>
  ) : null;

  const mobileTabs: MobileTab[] = NAV_ITEMS.map((item) => ({
    key: item.to,
    to: item.to,
    label: t(item.labelKey),
    Icon: item.Icon,
  }));

  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      {!isMobile && (
        <nav
          aria-label={t("common.appName")}
          className="flex w-[224px] shrink-0 flex-col gap-3 border-r border-border bg-sidebar p-3"
        >
          {brand}
          {searchBox}
          {navItems}
          <div className="flex-1" />
          <div className="border-t border-border" />
          {account}
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] items-center gap-3 border-b border-border bg-card px-4">
          {title ? (
            <span className="truncate text-[15px] font-bold text-foreground">
              {title}
            </span>
          ) : null}
          <span className="flex-1" />
          {right}
          {isMobile && mobileAccount}
          <AppControls />
        </header>
        <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-6">
          {children}
        </main>
        {/* 移动主导航：A6Z3k 底部 TabBar，只含真实目的地。固定在视口底部，
            不与页面操作争夺顶栏位置。 */}
        {isMobile && (
          <div className="sticky bottom-0 z-40">
            <MobileTabBar ariaLabel={t("common.appName")} items={mobileTabs} />
          </div>
        )}
      </div>
    </div>
  );
}
