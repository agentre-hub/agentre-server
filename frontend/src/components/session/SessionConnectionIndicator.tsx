import { LoaderCircle, Unplug, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { tierOf } from "@/components/session/SessionStatusBanner";
import type { SessionViewStatus } from "@/lib/sessionView";
import { cn } from "@agentre-hub/agentre-ui";

/**
 * A 档（瞬态自愈）的落点（规格 2026-08-21 决策 2）：详情头部的一枚状态芯片，
 * 外加钉在头部底边上的一条不定量进度条。
 *
 * 它接的是此前由横幅承担的 `connecting` / `reconnecting`。搬出来有两个理由：
 *
 *  1. **不占内容区。** 打开每一条对话都要经过这一段，几百毫秒后它自己就好了；
 *     为它把转录往下顶一格是不成比例的。
 *  2. **不用错误色。** 横幅的 variant 默认是 destructive，于是这两个状态一直是
 *     红的 —— 红色因此变廉价，真出事时不再有人当回事。
 *
 * 渲染的是**两个兄弟节点**而不是一个：芯片站在头部那一行里，进度条要横跨整条
 * 底边。塞进芯片里的话，那条线就只有一枚小胶囊那么宽，读不出「整个头部在等」。
 * 因此调用方的头部必须是 `relative`——进度条按它定位。
 */
const SHAPE: Record<string, { chip: string; bar: string; copyKey: string }> = {
  // 还没连上：中性的「在动」，用品牌色。
  connecting: {
    chip: "bg-primary-soft text-primary-text",
    bar: "bg-primary",
    copyKey: "session.status.connecting",
  },
  // 连上过又断了：比首连更值得注意，但仍然会自己回来，所以是 waiting 不是错误。
  reconnecting: {
    chip: "bg-status-waiting-bg text-status-waiting-text",
    bar: "bg-status-waiting",
    copyKey: "session.status.reconnecting",
  },
};

/** 「正在连接」持续这么久还没连上，就改口说「连不上」（规格 E1，对比稿 d2 B）。 */
export const UNREACHABLE_AFTER_MS = 20_000;

/**
 * `active` 连续为真满 `delayMs` 才返回 true；一旦转假立刻回到 false，下一段重新计时。
 *
 * 「连上了 / 恢复了」要立刻撤掉提示，而「出问题了」要熬过一段抖动才说——两头不对称，
 * 所以不用通用去抖。state 只在定时器回调里写（effect 体内不写 state），回到 false
 * 由 cleanup 复位。
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [fired, setFired] = useState(false);
  useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => setFired(true), delayMs);
    return () => {
      clearTimeout(id);
      setFired(false);
    };
  }, [active, delayMs]);
  return active && fired;
}

/** 距 `at`（Unix 毫秒）还有几整秒，向上取整，不为负。 */
function secondsUntil(at: number): number {
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * 页头下的「下次自动重试 N 秒后」。没排着重试（`nextRetryAt` 为空）就不画——
 * 一句没有数字的倒计时比没有更糟。每秒自己跳一格；点「立即重试」后宿主会换一个新的
 * `nextRetryAt`，倒计时从头算。
 */
export function RetryCountdownStrip({
  nextRetryAt,
}: {
  nextRetryAt: number | null | undefined;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!nextRetryAt) return;
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [nextRetryAt]);
  if (!nextRetryAt) return null;
  // now 只用来触发重渲染；读的是当下时钟。
  void now;
  return (
    <div
      role="status"
      data-testid="session-retry-countdown"
      className="flex shrink-0 items-center gap-2 bg-status-waiting-bg px-4 py-1.5 text-xs text-status-waiting-text"
    >
      <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {t("session.status.retryCountdown", {
          seconds: secondsUntil(nextRetryAt),
        })}
      </span>
    </div>
  );
}

export default function SessionConnectionIndicator({
  status,
  className,
  barOnly = false,
  unreachable = false,
  onRetry,
}: {
  status: SessionViewStatus;
  className?: string;
  /** 只画头部底边那条进度条：状态字已由宿主在别处说出（手机页头的副标题）。 */
  barOnly?: boolean;
  /**
   * 连了约 20 秒仍没连上：芯片改成可点的「连不上 · 立即重试」（接 `onRetry`）。
   * 没有 `onRetry` 就还是原来的「连接中」——一颗点了没反应的按钮比没有更坏。
   */
  unreachable?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  // B / C 档是横幅的事，正常态什么都不用说。
  if (tierOf(status) !== "transient") return null;
  const shape = SHAPE[status];
  if (!shape) return null;
  const stuck = unreachable && !!onRetry;

  return (
    <>
      {!barOnly && stuck && (
        <button
          type="button"
          data-session-status="unreachable"
          onClick={onRetry}
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs leading-none",
            "bg-status-waiting-bg text-status-waiting-text outline-none hover:brightness-95 focus-visible:focus-outline",
            className,
          )}
        >
          <Unplug aria-hidden className="size-3" />
          {t("session.status.unreachableRetry")}
        </button>
      )}
      {!barOnly && !stuck && (
        <span
          role="status"
          aria-live="polite"
          data-session-status={status}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs leading-none",
            shape.chip,
            className,
          )}
        >
          <LoaderCircle
            aria-hidden
            className="size-3 animate-spin motion-reduce:animate-none"
          />
          {t(shape.copyKey)}
        </span>
      )}
      {/* 进度条对读屏隐藏：芯片上的文字已经把同一件事说完了，一条量不出进度的
          装饰条再念一遍只是噪音。`motion-reduce` 下它停成一条静止的浅色线——
          记号还在，动效没了。 */}
      <span
        data-testid="connection-progress"
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
      >
        <span
          className={cn(
            "absolute inset-y-0 w-2/5 animate-[session-connect_1.25s_cubic-bezier(0.4,0,0.2,1)_infinite] rounded-full",
            "motion-reduce:inset-x-0 motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40",
            shape.bar,
          )}
        />
      </span>
    </>
  );
}
