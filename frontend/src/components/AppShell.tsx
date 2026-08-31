import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  KanbanSquare,
  LayoutDashboard,
  MessagesSquare,
  Monitor,
  Settings as SettingsIcon,
  SquareTerminal,
} from "lucide-react";

import AppControls from "@/components/AppControls";
import { ConsoleNavItem } from "@/components/console";
import { MobileTabBar, type MobileTab } from "@/components/console";
import { useIsMobile } from "@/components/use-is-mobile";
import { UserMenu } from "@/components/UserMenu";
import { useAccountChannel } from "@/hooks/use-account-channel";
import { useAliveEffect } from "@/hooks/use-api-query";
import { useMe } from "@/hooks/use-me";
import {
  AccountChannelDevicePresence,
  AccountChannelMirrorChanged,
} from "@/lib/accountChannel";
import { fetchDevices } from "@/lib/devices";
import { fetchWaitingCount } from "@/lib/waitingCount";
import { cn } from "@agentre-hub/agentre-ui";

/** /v1/devices 只取算设备 Meta 需要的字段。 */
interface DeviceMeta {
  online: number;
  total: number;
}

interface NavItem {
  to: string;
  labelKey: string;
  Icon: typeof LayoutDashboard;
  /** 设备：/v1/devices 在线/全部，与总览 tile 同一口径（取到才渲染 Meta）。 */
  meta?: DeviceMeta | null;
  /** 对话：账号里此刻等你处理的条数（取到且 > 0 才渲染角标）。 */
  badge?: number | null;
}

/**
 * 账号级控制台的外壳：桌面固定 224px SideNav（R969Y：Brand / 5 导航项 /
 * 账号区）+ 52px TopBar（title 槽 + right 槽 + AppControls）+ 主区；移动（≤767px）
 * 主导航改为 4 项的 A6Z3k 底部 TabBar，设置从账号菜单进入。
 *
 * 搜索无真实能力：外观保留但不可聚焦（div + aria-hidden，无 button/input/tabindex），
 * 也不显示 ⌘K 快捷键暗示。审计无后端，不进主导航。
 *
 * title / right 可选（向后兼容）：不传时 TopBar 左侧空、右侧仍渲染 AppControls。
 * 导航项尾部数据（设备在线/全部 Meta、账号区）都是锦上添花：
 * 取不到就隐藏对应元素，绝不阻塞整体渲染。
 */
export default function AppShell({
  title,
  right,
  flush,
  ownHeader,
  children,
}: {
  title?: string;
  right?: ReactNode;
  /**
   * 页面自己接管整块主区（对话页与会话详情）：不给内边距，也不让主区滚——
   * 由页面自己分带，把 Composer 钉在底上。别的页照旧由主区滚。
   */
  flush?: boolean;
  /**
   * 页面自己画顶栏（移动端对话索引）。窄屏上 52px 一条塞不下「标题 + 页面动作 +
   * 账号 + 语言/主题」，那一带交给页面自己排；壳这里就不能再画一条，否则两条顶栏
   * 叠着。
   */
  ownHeader?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { me } = useMe();
  const [deviceMeta, setDeviceMeta] = useState<DeviceMeta | null>(null);
  // 等你处理的对话条数。null = 还没取到 / 取不到，那时角标整个不画——一个停在旧值上的
  // 数字比没有数字更糟：它会让人以为没有新的东西在等自己。
  const [waiting, setWaiting] = useState<number | null>(null);

  useAliveEffect((alive) => {
    fetchDevices()
      .then((list) => {
        if (!alive()) return;
        setDeviceMeta({
          online: list.filter((d) => d.online).length,
          total: list.length,
        });
      })
      .catch(() => {});
  }, []);

  // 侧栏那个「在线/全部」此前只在挂载时取一次：一台机器上线之后要整页刷新或者切
  // 一次路由才看得到。只订在线态这一类信号——别人发条消息不该让侧栏重取一遍设备。
  //
  // 离线仍要等兜底轮询：server 那边的在线态是到期即离线的 Redis 键，没有下线信号
  // （见 accountChannel 的 AccountChannelDevicePresence）。
  const reloadDeviceMeta = useCallback(() => {
    fetchDevices()
      .then((list) => {
        setDeviceMeta({
          online: list.filter((d) => d.online).length,
          total: list.length,
        });
      })
      .catch(() => {});
  }, []);
  useAccountChannel([AccountChannelDevicePresence], reloadDeviceMeta);

  // 「等你处理」的条数跟着镜像变。它与上面那条各订各的种类：别人发条消息不该让侧栏
  // 重取一遍设备，一台机器上下线也不该让它重数一遍对话。共用的是同一条 websocket
  // （use-account-channel 的注释），多的只是一份订阅者名单。
  const reloadWaiting = useCallback(() => {
    fetchWaitingCount()
      .then((r) => setWaiting(r.waiting))
      .catch(() => {});
  }, []);
  useAliveEffect((alive) => {
    fetchWaitingCount()
      .then((r) => {
        if (!alive()) return;
        setWaiting(r.waiting);
      })
      .catch(() => {});
  }, []);
  useAccountChannel([AccountChannelMirrorChanged], reloadWaiting);

  // 第 4 项「组织」（规格 2026-08-18「server 端的组织管理面」）：与桌面端同形的
  // 组织索引 + 详情，外壳仍是这份 224px 带文字 SideNav。审计无后端，不进主导航。
  //
  // 第 5 项是设置。设置刻意不进移动 TabBar：窄屏留给高频目的地，设置从 TopBar 的
  // 用户菜单进入（与 /account 同一条可达路径）。移动 TabBar 由这个数组派生（见
  // 下方 mobileTabs）。
  const NAV_ITEMS: NavItem[] = [
    { to: "/overview", labelKey: "nav.overview", Icon: LayoutDashboard },
    {
      to: "/chat",
      labelKey: "nav.chat",
      Icon: MessagesSquare,
      badge: waiting,
    },
    // 第 3 项「看板」（规格 2026-08-27「看板：项目维度、筛选与呈现重构」）：与桌面端
    // 同一族共享呈现件画的那块板，账号级任务与标签都住在 sync_objects 里。
    { to: "/issues", labelKey: "nav.issues", Icon: KanbanSquare },
    {
      to: "/devices",
      labelKey: "nav.devices",
      Icon: Monitor,
      meta: deviceMeta,
    },
    { to: "/org", labelKey: "nav.org", Icon: Building2 },
    { to: "/settings", labelKey: "nav.settings", Icon: SettingsIcon },
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
        <span className="text-prose font-semibold text-foreground">
          {t("authLayout.brand")}
        </span>
        <span className="text-3xs text-muted-foreground">
          {t("appShell.productSub")}
        </span>
      </div>
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
          meta={item.meta ? `${item.meta.online}/${item.meta.total}` : null}
          badge={item.badge}
        />
      ))}
    </div>
  );

  // 账号数据取不到就整块隐藏，不伪造头像/名字。桌面侧栏与移动 TopBar 共用
  // 同一个下拉菜单触发器（UserMenu）：可键盘打开/关闭，菜单项为账号信息
  // （只读）、账号与安全（去 /account）、登出。
  const account = me ? <UserMenu me={me} /> : null;

  // 移动端账号进 TopBar：抽屉已移除，账号仍需可达，用紧凑形态（只有头像）。
  const mobileAccount = me ? <UserMenu me={me} compact /> : null;

  // 桌面 SideNav 第 5 项是设置，移动 TabBar 不要它：窄屏留给高频目的地，
  // 设置从 TopBar 的用户菜单进入。
  const mobileTabs: MobileTab[] = NAV_ITEMS.filter(
    (item) => item.to !== "/settings",
  ).map((item) => ({
    key: item.to,
    to: item.to,
    label: t(item.labelKey),
    Icon: item.Icon,
  }));

  /*
    整页不滚：滚动落在 main 里。此前根是 min-h-screen，页面高于视口时整份文档往下
    滚——于是「把输入框钉在底上」在壳被约束住之前根本无从谈起（侧栏、顶栏、会话列
    表会一起被卷走）。改成 h-screen + overflow-hidden，非 flush 的页由 main 自己
    overflow-y-auto，观感与此前一致。
  */
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background md:flex-row">
      {!isMobile && (
        <nav
          aria-label={t("common.appName")}
          className="flex w-[224px] shrink-0 flex-col gap-3 border-r border-border bg-sidebar p-3"
        >
          {brand}
          {navItems}
          <div className="flex-1" />
          <div className="border-t border-border" />
          {account}
        </nav>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!ownHeader && (
          <header
            data-testid="app-topbar"
            className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-card px-4"
          >
            {title ? (
              <span className="truncate text-prose font-bold text-foreground">
                {title}
              </span>
            ) : null}
            <span className="flex-1" />
            {right}
            {isMobile && mobileAccount}
            <AppControls />
          </header>
        )}
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            flush
              ? "overflow-hidden"
              : "overflow-y-auto px-4 py-5 md:px-8 md:py-6",
          )}
        >
          {children}
        </main>
        {/* 移动主导航：A6Z3k 底部 TabBar，只含真实目的地。固定在视口底部，
            不与页面操作争夺顶栏位置。 */}
        {isMobile && (
          /* 外层已经不滚了，sticky 没有意义：shrink-0 就够把它按在视口底上。 */
          <div className="shrink-0">
            <MobileTabBar ariaLabel={t("common.appName")} items={mobileTabs} />
          </div>
        )}
      </div>
    </div>
  );
}
