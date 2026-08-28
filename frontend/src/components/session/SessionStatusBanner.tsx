import {
  Lock,
  LogIn,
  MonitorOff,
  RotateCw,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  Button,
  MachineOfflineBanner,
  StatusBanner,
  type StatusBannerTone,
} from "@agentre-hub/agentre-ui";
import { formatRelativeTime, type SessionViewStatus } from "@/lib/sessionView";

/**
 * 状态横幅（规格 2026-08-21「连接态与失败态」）。
 *
 * 九个视图状态按**用户还能做什么**分三档（决策 1），不按信号来自哪一层分：
 *
 *  - `transient` 瞬态自愈（connecting / reconnecting）——**这里一个字都不渲染**。
 *    它搬去了详情头部的进度条与芯片（决策 2）：每打开一条对话都要经过、几百毫秒
 *    后自己就好的状态，不该把转录顶下去，更不该是红的。
 *  - `blocking` 阻断可恢复——吸顶横幅，「一行结论 + 一行后果 + 至多一个出口」。
 *  - `final` 终态只读——中性色。既成事实不是警报，红色会让人以为再试试也许能好。
 *
 * 外壳本身（三档 tone、容器查询下的动作换行、吸顶）已经抬进共享包的 `StatusBanner`
 * ——桌面端画同一件事时用的是同一份。本文件因此只剩一张**映射表**：视图状态 →
 * tone / 图标 / 文案 / 出口。六档全部经包渲染，本站不再留第二个外壳。
 */
export type StatusTier = "transient" | "blocking" | "final";

export function tierOf(status: SessionViewStatus): StatusTier | null {
  switch (status) {
    case "connected":
      return null;
    case "connecting":
    case "reconnecting":
      return "transient";
    case "deviceRevoked":
    case "loggedOut":
      return "final";
    default:
      return "blocking";
  }
}

interface Shape {
  tone: StatusBannerTone;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}

/**
 * `blocking` 这一档内部还分两种，因为它们要的动作不一样：
 *
 *  - `alarm`   目标彻底够不着（连接断了 / 机器不在 / App 没开）→ 要去处理
 *  - `limited` 读得了、写不了（钉住的 agentred 不可用）→ 会自己恢复，等
 *  - `settled` 终态 → 中性
 *
 * `machineOffline` 不在表里：它整档都由包的 `MachineOfflineBanner` 画（含 tone
 * 与图标），本站在那一档只给「按下去往哪走」。
 */
const SHAPE: Record<string, Shape> = {
  lost: { tone: "alarm", Icon: Unplug },
  desktopAppNotRunning: { tone: "alarm", Icon: MonitorOff },
  pinnedAgentredUnavailable: { tone: "limited", Icon: TriangleAlert },
  deviceRevoked: { tone: "settled", Icon: Lock },
  loggedOut: { tone: "settled", Icon: LogIn },
};

/**
 * 说明与「最后在线」之间的分隔符。提出来是因为 `i18next/no-literal-string` 会拦下
 * JSX 里的裸字面量 —— 它拦得对：这一格不是文案，是排版符号，不该进 t()。
 * 详情头部的 mono meta 行用的是同一枚（`META_SEP`）。
 */
const META_SEP = " · ";

/** 认得出机器名的状态：标题里说出它是哪一台，认不出就退到通用说法。 */
const NAMED_STATUSES = new Set(["desktopAppNotRunning"]);

export default function SessionStatusBanner({
  status,
  machineName,
  machineLastSeenMs,
  onReconnect,
  onStartNew,
}: {
  status: SessionViewStatus;
  /** 目标机器的名字。取不到就不编一个占位名，标题退到「这台机器」。 */
  machineName?: string;
  machineLastSeenMs?: number;
  /**
   * 「重新连接」。只有 `lost`（重试已经耗尽）用得上，而且**只在调用方接得住时
   * 才摆**——一个按下去什么都不会发生的按钮比没有按钮更坏。
   */
  onReconnect?: () => void;
  /**
   * 「新建一个会话」。`machineOffline` 那一档的出口（两端统一）；导航是本站的事，
   * 包只回调。
   *
   * 必填而不是可选：那一档**必须**有出口——横幅说完「离线」就没有下文的话，人只能
   * 对着卡死的输入框干等。`onReconnect` 可选是因为 `lost` 在接不住时宁可不摆按钮；
   * 这一档不存在「接不住」的情形，本站任何一处都开得出新对话。
   */
  onStartNew: () => void;
}) {
  const { t, i18n } = useTranslation();
  const tier = tierOf(status);
  // 正常态与瞬态都不占内容区（决策 1 / 2）。
  if (tier === null || tier === "transient") return null;

  /**
   * 「最后在线」走全站的相对时间口径（`formatRelativeTime`，与索引行、详情头部
   * 同一处）。此前这里是 `toLocaleString()` 的完整机器格式，同一屏里两套时间口径
   * 并存，读者要自己换算。精确时刻挂在 `title` 上，需要时仍查得到。
   */
  const lastSeenMs =
    machineLastSeenMs && machineLastSeenMs > 0 ? machineLastSeenMs : null;

  // 这一档整个住在包里：文案是两端的并集，出口是两端统一的那一个。
  if (status === "machineOffline") {
    return (
      <MachineOfflineBanner
        sticky
        data-session-status={status}
        data-tier={tier}
        machineName={machineName}
        lastSeen={
          lastSeenMs
            ? {
                text: formatRelativeTime(lastSeenMs, i18n.language),
                dateTime: new Date(lastSeenMs).toISOString(),
                exact: new Date(lastSeenMs).toLocaleString(),
              }
            : undefined
        }
        onStartNew={onStartNew}
      />
    );
  }

  const shape = SHAPE[status];
  if (!shape) return null;
  const { tone, Icon } = shape;

  const title = NAMED_STATUSES.has(status)
    ? machineName
      ? t(`session.banner.${status}.title`, { machine: machineName })
      : t(`session.banner.${status}.titleUnknown`)
    : t(`session.banner.${status}.title`);

  return (
    <StatusBanner
      sticky
      data-session-status={status}
      data-tier={tier}
      tone={tone}
      icon={<Icon className="size-4" aria-hidden />}
      title={title}
      body={t(`session.banner.${status}.body`)}
      meta={
        lastSeenMs ? (
          <>
            {META_SEP}
            <time
              data-testid="status-banner-last-seen"
              dateTime={new Date(lastSeenMs).toISOString()}
              title={new Date(lastSeenMs).toLocaleString()}
            >
              {t("session.banner.lastSeen", {
                time: formatRelativeTime(lastSeenMs, i18n.language),
              })}
            </time>
          </>
        ) : null
      }
      action={renderAction()}
    />
  );

  function renderAction(): ReactNode {
    switch (status) {
      case "lost":
        return onReconnect ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full @md:w-auto"
            onClick={onReconnect}
          >
            <RotateCw aria-hidden className="size-3.5" />
            {t("session.banner.reconnect")}
          </Button>
        ) : null;
      case "desktopAppNotRunning":
      case "pinnedAgentredUnavailable":
        return (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="w-full @md:w-auto"
          >
            <Link to="/devices">{t("session.banner.viewDevice")}</Link>
          </Button>
        );
      case "loggedOut":
        return (
          <Button asChild size="sm" className="w-full @md:w-auto">
            {/* 早就写好、却从没被任何一处引用过的那个键，终于有了归宿。 */}
            <Link to="/login">{t("session.relogin")}</Link>
          </Button>
        );
      default:
        // 设备已被移除是永久的：没有任何一个按钮能改变它，所以一个都不摆。
        return null;
    }
  }
}
