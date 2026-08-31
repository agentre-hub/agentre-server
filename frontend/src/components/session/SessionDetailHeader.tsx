import { rpcMethods } from "@agentre-hub/agentre-wire";
import type { SessionSummary } from "@agentre-hub/agentre-wire";
import { useState, type ReactNode, type RefObject } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Monitor, MoreHorizontal, Square } from "lucide-react";
import {
  copyTextWithToast,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  StatusDot,
  Button,
  cn,
} from "@agentre-hub/agentre-ui";

import SessionConnectionIndicator from "@/components/session/SessionConnectionIndicator";
import { useIsMobile } from "@/components/use-is-mobile";
import type { RelayClient } from "@/lib/relayClient";
import {
  formatRelativeTime,
  toAgentStatus,
  type SessionViewStatus,
} from "@/lib/sessionView";

/** mono meta 行里各段之间的分隔符。在 JS 里拼，不进 JSX（裸字符串守卫）。 */
const META_SEP = "\u00b7";

export interface SessionDetailHeaderProps {
  /** 路由页形态才有面包屑 / 移动返回（决策 16）。 */
  isPage: boolean;
  did: number;
  sid: number;
  /**
   * 头部认这条对话用的摘要：中继的实况优先，没有时退到账号镜像那一行。
   * 派生规则在 SessionDetailView 的 `identity` 那里。
   */
  identity: SessionSummary | null;
  /** 解出来的 Agent。解不出（老会话、或它已不在账号里）时为 null。 */
  agent: { name: string } | null;
  /** 头部那一档头像。在 JSX 之外算好，见 SessionDetailView 的 headerAvatar。 */
  avatar: ReactNode;
  displayTitle: string;
  machineName: string | undefined;
  machineOnline: boolean | null | undefined;
  status: SessionViewStatus;
  /** 这一轮在不在跑 —— 只有在跑的时候才摆「停止」。 */
  running: boolean;
  /**
   * 宿主页面级的那簇控件（Chat 桌面档的连接态 + 语言/主题）。
   *
   * 嵌入形态下这个头部**就是**那一页的顶带：壳不再画 52px 顶栏，那簇控件没有别的
   * 落点，于是摆在这一行的最右端。路由页形态不传（壳的顶栏还在）。
   */
  headerRight?: ReactNode;
  clientRef: RefObject<RelayClient | null>;
  originRef: RefObject<string | undefined>;
}

/**
 * 详情头部：面包屑（页面形态）+ 身份行（头像 / 标题 / mono meta 行）+ 连接指示
 * + 停止。
 *
 * 「这一轮停不停得下来」整片归它：`aborting` 与 `abortTurn` 除了这颗按钮没有第二
 * 个读者。
 */
export default function SessionDetailHeader({
  isPage,
  did,
  sid,
  identity,
  agent,
  avatar,
  displayTitle,
  machineName,
  machineOnline,
  status,
  running,
  headerRight,
  clientRef,
  originRef,
}: SessionDetailHeaderProps) {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const isMobile = useIsMobile();
  /** 正在发停止请求（按下去到应答之间不重复发）。 */
  const [aborting, setAborting] = useState(false);

  /** 把这一轮停下来（wire 的 runtime.abort）。与 run / steer 同样要带回 origin。 */
  async function abortTurn() {
    const c = clientRef.current;
    if (!c) return;
    setAborting(true);
    try {
      await c.request(rpcMethods.runtimeAbort, {
        sessionId: BigInt(sid),
        ...(originRef.current ? { peerFingerprint: originRef.current } : {}),
      });
    } catch {
      // 停不下来不另开一条错误面：这一轮的实时流会照常继续，状态自己说话。
    } finally {
      setAborting(false);
    }
  }

  /**
   * 把会话号交给剪贴板。
   *
   * 交的是**裸号**，不带 `#`：复制出来是要拿去搜 daemon 日志、查 `agent_sessions`、
   * 或者贴给别人的，多一个字符每次都得手动删掉。
   *
   * 回执只能是 toast —— 菜单一选就关，内联的「已复制」没有地方留（设备指引那处
   * 的按钮一直在屏上，所以那边才用得起内联态）。所以走共享包的 `copyTextWithToast`
   * 而不是自己拼一遍：复制不成时它给的说明恰好是本站最常撞上的那一种 ——
   * `http://<局域网 IP>:port` 不是安全上下文，`navigator.clipboard` 整个对象都不
   * 存在，`execCommand` 也兜不住。谎报成功比复制失败更糟：用户会带着一个空剪贴板
   * 去粘贴，而屏幕刚说过复制好了。
   */
  async function copySessionId() {
    await copyTextWithToast(String(sid), {
      successTitle: t("session.menu.sessionIdCopied"),
      errorTitle: t("session.menu.copySessionIdFailed"),
    });
  }

  /** mono meta 行的各段。只有拿得出来的才进来（分隔符由渲染处夹在两段之间）。 */
  /** `hideAt` = 窄档先收哪一段（决策 4）。收起的那一段在别处还说得出。 */
  const metaParts: {
    key: string;
    node: React.ReactNode;
    hideAt?: string;
  }[] = [];
  if (identity?.lifecycleState || agent) {
    metaParts.push({
      key: "agent",
      node: (
        <span
          data-testid="session-detail-status"
          className="inline-flex shrink-0 items-center gap-1"
        >
          {identity?.lifecycleState && (
            <StatusDot
              status={toAgentStatus({
                lifecycleState: identity.lifecycleState,
                waitingForInput: identity.waitingForInput,
              })}
              size="xs"
            />
          )}
          {/* 状态不只靠颜色：四个态都有可见文字（session.list.*）。Agent 名认不出来时
              （老会话没有 agentSyncId）退回状态文字，不填占位名。 */}
          {agent?.name ??
            (identity?.waitingForInput
              ? t("session.list.waiting")
              : identity?.lifecycleState === "running"
                ? t("session.list.running")
                : identity?.lifecycleState === "interrupted"
                  ? t("session.list.interrupted")
                  : t("session.list.idle"))}
        </span>
      ),
    });
  }
  if (identity?.lastMessageAt) {
    metaParts.push({
      key: "updated",
      node: (
        <time
          dateTime={new Date(identity.lastMessageAt).toISOString()}
          className="shrink-0"
        >
          {formatRelativeTime(identity.lastMessageAt, i18n.language)}
        </time>
      ),
    });
  }
  if (machineName) {
    metaParts.push({
      key: "machine",
      // 最先收：机器名在面包屑与设备页里都还在，这一行不是它唯一的出处。
      hideAt: "@max-[560px]/header:hidden",
      node: (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Monitor aria-hidden="true" className="size-3" />
          {machineName}
          <span
            className={
              machineOnline === false
                ? "text-muted-foreground"
                : "text-status-running-text"
            }
          >
            {machineOnline === false
              ? t("session.breadcrumb.offline")
              : t("session.breadcrumb.online")}
          </span>
        </span>
      ),
    });
  }

  return (
    <div
      data-testid="session-detail-header"
      // relative：连接指示器的那条进度条按头部定位，铺满它的底边（决策 2）。
      //
      // 两种形态的外层不同高：路由页形态要在身份行之上再摆一行面包屑，所以是
      // 「面包屑 + 身份行」两段加一圈内边距；嵌入形态没有面包屑，外层就**是**那条
      // 68px 顶带 —— 此前它照样带着那圈 `py-2.5`，把 68 撑成 89，什么都没多装。
      className={cn(
        "relative flex shrink-0 flex-col border-b border-border bg-card px-5",
        isPage ? "gap-2 py-2.5" : "h-[68px]",
      )}
    >
      {isPage && (
        /* 路由页导航（决策 16，屏 22）：移动返回 + 设备名；桌面面包屑。 */
        <nav
          aria-label={t("session.breadcrumb.devices")}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          {isMobile ? (
            <>
              {/* 下钻三联的返回：设备 → 这台机器的对话 → 对话详情（决策 16，屏 22）。 */}
              <Link
                to={`/devices/${did}/sessions`}
                aria-label={t("session.breadcrumb.back")}
                className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="size-5" aria-hidden="true" />
              </Link>
              <span className="truncate font-semibold text-foreground">
                {machineName ?? ""}
              </span>
              <span
                className={
                  machineOnline === false
                    ? "text-destructive"
                    : "text-status-waiting"
                }
              >
                {machineOnline === false
                  ? t("session.breadcrumb.offline")
                  : t("session.breadcrumb.online")}
              </span>
              <span className="flex-1" />
              {/* 这里曾经是「关注 / 取消关注」那个书签开关。它随决策 5 一起作废：
                  收进账号现在叫**保存**，入口在索引的机器轴那一档（决策 11），
                  而且第一次保存要先说清楚内容会被存到服务器上（决策 2）——一个
                  顶栏图标表达不了这件事。 */}
            </>
          ) : (
            <>
              <Link
                to="/devices"
                className="font-medium text-muted-foreground hover:text-foreground"
              >
                {t("session.breadcrumb.devices")}
              </Link>
              <span aria-hidden="true" className="text-decorative-foreground">
                /
              </span>
              <Link
                to={`/devices/${did}/sessions`}
                className="font-medium text-muted-foreground hover:text-foreground"
              >
                {machineName ?? ""}
              </Link>
              <span className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => nav("/devices")}
              >
                {t("session.breadcrumb.switchMachine")}
              </Button>
            </>
          )}
        </nav>
      )}

      {/*
        详情头部，与桌面端 chat-panel 的 toolbar 同形：头像 + 两行（标题 / mono
        meta 行）+ 停止。

        此前只有三样：标题、一枚状态胶囊、「机器 · 在线」——打开一条对话看不出是哪个
        Agent 在跑、上一次动是什么时候，也没有办法把跑飞的一轮停下来。

        **项目**那一维不摆：SessionSummary 上没有它（只有账号镜像那一行有），
        摆一个猜出来的项目名比不摆更糟。
      */}
      {/* 身份行恒高（与桌面端同一条结论，规格 2026-08-23 决策 3）：高度写死为两行
          标题的高度、整块垂直居中 —— 标题长短不再改变它。
          @container/header 让 meta 行按**这一带的实际宽度**分档降级，而不是靠
          flex-wrap 折行把头部撑高（决策 4）。 */}
      <div
        data-testid="session-detail-identity"
        className="@container/header flex h-[68px] items-center gap-3"
      >
        {avatar}
        <div className="min-w-0 flex-1">
          {/* 页面形态的标题由 AppShell TopBar 呈现，不在这里重复。 */}
          {!isPage && (
            <h2 className="line-clamp-2 break-words text-sm font-semibold leading-snug text-foreground">
              {displayTitle}
            </h2>
          )}
          <div
            data-testid="session-detail-meta"
            className="mt-0.5 flex min-w-0 items-center gap-x-1.5 overflow-hidden font-mono text-2xs whitespace-nowrap text-muted-foreground"
          >
            {/* 分隔符夹在**真的存在的**相邻两段之间：还没跑过第一轮的会话没有
                状态、也没有活动时间，逐段各自带一个前置「·」会在行首留下一个
                孤零零的分隔符。 */}
            {metaParts.map((part, i) => (
              <span
                key={part.key}
                data-testid={`session-detail-meta-${part.key}`}
                className={cn(
                  "inline-flex min-w-0 items-center gap-1.5",
                  part.hideAt,
                )}
              >
                {i > 0 && (
                  <span className="text-border-strong">{META_SEP}</span>
                )}
                {part.node}
              </span>
            ))}
          </div>
        </div>
        {/* 正在连 / 正在重连（决策 2）：横幅不再承担这两个状态，它们在这里。
            `connected` 与 B / C 档下这一枚不渲染，头部因此不会常驻一块噪音。 */}
        <SessionConnectionIndicator status={status} />
        {/* 停止：wire 上一直有 runtime.abort，这一端真发得出去。只在这一轮真的在跑
            的时候摆——闲着的时候没有什么可停。 */}
        {running && (
          <Button
            variant="outline"
            size="sm"
            data-testid="session-detail-stop"
            disabled={aborting || status !== "connected"}
            onClick={() => void abortTurn()}
          >
            <Square aria-hidden="true" className="size-3.5" />
            {t("session.abort")}
          </Button>
        )}
        {/* 更多操作。形态跟桌面端 chat-panel-header 同一套：**点击**打开的下拉。
            右键那份在左栏的行上（SessionIndex 的 RowContextMenu），而右栏正读着
            这条对话时没有「哪一行」可点。

            这颗按钮此前不摆，理由写在 SessionDetailView 的抬头：画板里那几样在
            协议上没有对应物，点开全是灰项不如不摆。复制会话号把这条理由破了 ——
            号就在这一屏手里，不需要任何协议支持，而它恰恰是排查时第一件要的
            东西（对 daemon 日志、查 agent_sessions、跟人报问题）。 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("session.menu.more")}
              data-testid="session-detail-menu-trigger"
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            <DropdownMenuItem onSelect={() => void copySessionId()}>
              {t("session.menu.copySessionId")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 宿主的那簇页面级控件（嵌入形态才有）：与「停止」隔一条竖线，免得两组
            不同层级的东西看起来是一排同类按钮。 */}
        {headerRight && (
          <>
            <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
            {headerRight}
          </>
        )}
      </div>
    </div>
  );
}
