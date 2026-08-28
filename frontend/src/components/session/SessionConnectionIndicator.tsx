import { LoaderCircle } from "lucide-react";
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

export default function SessionConnectionIndicator({
  status,
  className,
}: {
  status: SessionViewStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  // B / C 档是横幅的事，正常态什么都不用说。
  if (tierOf(status) !== "transient") return null;
  const shape = SHAPE[status];
  if (!shape) return null;

  return (
    <>
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
        <LoaderCircle aria-hidden className="size-3 animate-spin" />
        {t(shape.copyKey)}
      </span>
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
