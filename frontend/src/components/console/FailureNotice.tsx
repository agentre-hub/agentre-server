import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";

import { Button, copyTextWithToast } from "@agentre-hub/agentre-ui";

import { useIsMobile } from "@/components/use-is-mobile";
import type { Failure } from "@/lib/describeFailure";

/**
 * 一次失败摆出来的样子（规格 2026-11-05-ux-polish W5）：`describeFailure` 给的那句话，
 * 加上它给的出口，再加一颗「复制诊断信息」。只出一行的内容（文字 + 弹簧 + 按钮），
 * 外框（Alert / 提示条）由调用方按自己的位置给。
 *
 * - 「重试」只在分类说重试有用、且调用方给了 `onRetry` 时出现；
 * - 「去设备页」只在分类指向设备页、且调用方不在设备页上时出现（`devicesExit`）；
 * - 「重新登录」在分类说登录失效（401）时出现，是指向登录页的整页跳转（带 next）。
 *   全局 401 处理（`setUnauthorizedHandler`）通常已经在清本地、送去登录页；这颗键是
 *   它走完之前、或没有处理器的场合（嵌入页、登录页自己）的就地出口，只跳转、不再清
 *   一遍——两者同时发生只是两次去同一个地方，不冲突；
 * - 手机上这几颗键都是 44px（规格 G1），桌面保持原尺寸；
 * - 原文只走剪贴板，不上屏。复制走共享包的 `copyTextWithToast`：本站常在 http 上，
 *   那里 Clipboard API 整个不存在，包里那层有 `execCommand` 兜底；回执是 toast。
 */
export function FailureNotice({
  failure,
  onRetry,
  retryLabel,
  retryDisabled,
  devicesExit = true,
}: {
  failure: Failure;
  onRetry?: () => void;
  /** 重试按钮的文案；不给就用通用的「重试」。 */
  retryLabel?: string;
  retryDisabled?: boolean;
  /** 本身就在设备页上的调用方关掉它：再给一条去设备页的路是原地打转。 */
  devicesExit?: boolean;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { pathname, search } = useLocation();
  const tall = isMobile ? "min-h-11 px-4" : undefined;
  return (
    <>
      <span className="min-w-0">{failure.message}</span>
      <span className="flex-1" />
      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
        {onRetry && failure.exit === "retry" && (
          <Button
            size="xs"
            variant="outline"
            className={tall}
            disabled={retryDisabled}
            onClick={onRetry}
          >
            {retryLabel ?? t("common.retry")}
          </Button>
        )}
        {failure.exit === "signIn" && (
          <Button asChild size="xs" variant="outline" className={tall}>
            <a href={`/login?next=${encodeURIComponent(pathname + search)}`}>
              {t("common.failure.signIn")}
            </a>
          </Button>
        )}
        {devicesExit && failure.exit === "devices" && (
          <Button asChild size="xs" variant="outline" className={tall}>
            <Link to="/devices">{t("common.failure.goDevices")}</Link>
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className={tall}
          onClick={() =>
            void copyTextWithToast(failure.diagnostic, {
              successTitle: t("common.failure.copied"),
            })
          }
        >
          {t("common.failure.copyDiagnostics")}
        </Button>
      </span>
    </>
  );
}
