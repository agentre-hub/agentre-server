import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  KanbanSquare,
  LayoutDashboard,
  MessagesSquare,
  Monitor,
  Settings as SettingsIcon,
  SquareTerminal,
} from "lucide-react";

import AppControls from "@/components/AppControls";
import { ConnectionEscape } from "@/components/ConnectionStatus";
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
import { readNavCollapsed, writeNavCollapsed } from "@/lib/navCollapsed";
import {
  fetchAttentionCounts,
  type AttentionCounts,
} from "@/lib/attentionCount";
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
  /** 对话：账号里此刻需要你的条数（取到且 > 0 才渲染角标）。 */
  badge?: number | null;
  /** 那个数是怎么来的（「N 条等你处理 · M 条未读」）。 */
  badgeLabel?: string | null;
}

/**
 * 账号级控制台的外壳：桌面 224px SideNav（R969Y：Brand / 5 导航项 /
 * 账号区）+ 52px TopBar（title 槽 + right 槽 + AppControls）+ 主区；移动（≤767px）
 * 主导航改为 4 项的 A6Z3k 底部 TabBar，设置从账号菜单进入。
 *
 * 侧栏可以收成 56px 的图标栏，选择记在这台机器上（navCollapsed）。收起的是
 * **文字**不是导航：六个目的地一个不少，可访问名、等你处理的角标都还在，
 * 设备的在线/全部换到悬浮说明里（见 ConsoleNavItem 的 collapsed）。整条藏掉是
 * 另一回事——那会让「换个目的地」先要想起有个按钮，而这块屏最常见的动作正是换页。
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
  // 需要你的对话条数，按理由分开。null = 还没取到 / 取不到，那时角标整个不画——一个
  // 停在旧值上的数字比没有数字更糟：它会让人以为没有新的东西在等自己。
  const [attention, setAttention] = useState<AttentionCounts | null>(null);
  // 收起态从本机偏好起手，而不是每次进来都从展开开始：这是每天要重做一遍的选择。
  const [navCollapsed, setNavCollapsed] = useState(readNavCollapsed);
  const toggleNav = useCallback(() => {
    setNavCollapsed((prev) => {
      writeNavCollapsed(!prev);
      return !prev;
    });
  }, []);

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

  // 「需要你」的条数跟着镜像变。它与上面那条各订各的种类：别人发条消息不该让侧栏
  // 重取一遍设备，一台机器上下线也不该让它重数一遍对话。共用的是同一条 websocket
  // （use-account-channel 的注释），多的只是一份订阅者名单。
  const reloadAttention = useCallback(() => {
    fetchAttentionCounts()
      .then(setAttention)
      .catch(() => {});
  }, []);
  useAliveEffect((alive) => {
    fetchAttentionCounts()
      .then((counts) => {
        if (!alive()) return;
        setAttention(counts);
      })
      .catch(() => {});
  }, []);
  useAccountChannel([AccountChannelMirrorChanged], reloadAttention);

  /*
    角标上那一个数字，与拆开说明它的那句话。

    角标画的是**和**：它回答「还有几条要我管」，而「挡在那里等我按」与「跑出了新
    东西我还没看」都属于这个问题。分成两颗并排的角标会让 34px 的一行开始排版，也
    会逼用户在扫一眼导航时做加法。

    但两件事不能就这么糊成一个数：拆开的那句话落在 title 与读屏文字上（NavBadge），
    「3」从此说得出自己是 2 + 1 还是 0 + 3。0 的那一半不进这句话——一句「0 条等你
    处理」是纯噪声。

    counts 为 null（还没取到 / 取不到）时两样都是 null，角标整个不画。
  */
  const badge = attention ? attention.needsAttention + attention.unread : null;
  const badgeLabel = attention
    ? [
        attention.needsAttention > 0
          ? t("appShell.nav.chatBadge.needsAttention", {
              count: attention.needsAttention,
            })
          : null,
        attention.unread > 0
          ? t("appShell.nav.chatBadge.unread", { count: attention.unread })
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

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
      badge,
      badgeLabel,
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

  /*
    Brand 与收放开关同一带。收起时它们改成上下排：56px 里并排放不下两个 28px 的
    方块，而开关必须一直在——把它挪去顶栏的话，一条只在某些页出现的顶栏就成了
    「侧栏能不能回来」的前提。
  */
  const brand = (
    <div
      className={cn(
        "flex h-10 items-center gap-2 p-1.5",
        navCollapsed && "justify-center",
      )}
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary">
        <SquareTerminal
          className="size-4 text-primary-foreground"
          aria-hidden="true"
        />
      </div>
      {!navCollapsed && (
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-prose font-semibold text-foreground">
            {t("authLayout.brand")}
          </span>
          <span className="text-3xs text-muted-foreground">
            {t("appShell.productSub")}
          </span>
        </div>
      )}
    </div>
  );

  const toggleLabel = t(
    navCollapsed ? "appShell.nav.expand" : "appShell.nav.collapse",
  );

  /*
    收放开关钉在侧栏右边框上，而不是长在 brand 带里。

    此前它在 brand 带里：展开时贴右端，收起时那一带改成上下排，于是 brand 区从
    40px 变成 72px、整列导航跟着下移——收放两次，眼睛要重新找两次开关。它是这条栏
    上唯一一个会改变自身位置的控件，偏偏又是那个「要能马上找回来」的。

    钉在边框上之后，两态同一个 y（相对侧栏定位，不随内边距变），稳态下侧栏一个像素
    都不给它：平时透明，鼠标进这条栏或键盘聚焦到它时才显形。顶栏那个位置不能用——
    `ownHeader` 的页面自己画顶栏（移动端对话索引），把开关放上去等于让「侧栏能不能
    回来」取决于当前在哪一页。

    不配快捷键：这是一块偶尔来一次的 web 控制台，⌘B 在浏览器里另有主人（书签栏），
    在输入框里是加粗，为一条一天按不了两次的收放去抢它不值。
  */
  const navToggle = (
    <button
      type="button"
      aria-label={toggleLabel}
      title={toggleLabel}
      onClick={toggleNav}
      className={cn(
        "absolute top-5 -right-3 z-10 flex size-6 items-center justify-center rounded-full",
        "border border-border bg-card text-muted-foreground shadow-overlay",
        "opacity-0 transition-opacity hover:text-foreground",
        "group-hover/nav:opacity-100 focus-visible:opacity-100",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      {navCollapsed ? (
        <ChevronRight className="size-3.5" aria-hidden="true" />
      ) : (
        <ChevronLeft className="size-3.5" aria-hidden="true" />
      )}
    </button>
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
          badgeLabel={item.badgeLabel}
          collapsed={navCollapsed}
        />
      ))}
    </div>
  );

  // 账号数据取不到就整块隐藏，不伪造头像/名字。桌面侧栏与移动 TopBar 共用
  // 同一个下拉菜单触发器（UserMenu）：可键盘打开/关闭，菜单项为账号信息
  // （只读）、账号与安全（去 /account）、登出。
  const account = me ? <UserMenu me={me} compact={navCollapsed} /> : null;

  // 移动端账号进 TopBar：抽屉已移除，账号仍需可达，用紧凑形态（只有头像）。
  const mobileAccount = me ? <UserMenu me={me} compact /> : null;

  // 桌面 SideNav 第 5 项是设置，移动 TabBar 不要它：窄屏留给高频目的地，
  // 设置从 TopBar 的用户菜单进入。
  //
  // 角标跟着一起过去：这里此前只搬 key/to/label/Icon，于是「有多少条在等你」在窄屏
  // 上完全看不到——而底部这条栏正是移动端的主导航。设备那格 meta 仍不搬：一行 mono
  // 数字在 tab 底下排不下，那一维在移动端本来就由设备页自己说。
  const mobileTabs: MobileTab[] = NAV_ITEMS.filter(
    (item) => item.to !== "/settings",
  ).map((item) => ({
    key: item.to,
    to: item.to,
    label: t(item.labelKey),
    Icon: item.Icon,
    badge: item.badge,
    badgeLabel: item.badgeLabel,
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
          className={cn(
            "group/nav relative flex shrink-0 flex-col gap-3 border-r border-border bg-sidebar transition-[width]",
            navCollapsed ? "w-[56px] p-2" : "w-[224px] p-3",
          )}
        >
          {brand}
          {navToggle}
          {navItems}
          <div className="flex-1" />
          <div className="border-t border-border" />
          {/* 断线时的出路挨着账号块：那颗痣就在这里，说的是同一件事的两面
              （见 ConnectionStatus 的 ConnectionEscape）。稳态下它整个不渲染。 */}
          <ConnectionEscape variant={navCollapsed ? "icon" : "bar"} />
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
            {/* 移动端没有侧栏，这一枚就落在 TopBar 上：断线在窄屏上一样要有出路。 */}
            {isMobile && <ConnectionEscape variant="icon" />}
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
