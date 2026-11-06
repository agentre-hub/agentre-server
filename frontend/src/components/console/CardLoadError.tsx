import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@agentre-hub/agentre-ui";

import { FailureNotice } from "./FailureNotice";
import { describeFailure } from "@/lib/describeFailure";

/**
 * 卡片读取失败：说出原因，并给一条回程。
 *
 * 没有这颗按钮的话，用户唯一的出路是刷新整页——而这一页另外两张卡此刻可能好好的。
 * 三处消费（`/account` 的两张卡、设备详情、总览统计）此前各写一遍同一条
 * destructive Alert + 文案 + 弹簧 + 重试按钮，收成一份。
 *
 * 文案经 `describeFailure` 分类（规格 2026-11-05-ux-polish W5）：调用方只给「什么没取到」
 * 那半句（`what`），原因与出口由分类给；原文与恒为中文的 `ApiError.message` 只进
 * 「复制诊断信息」。
 */
export function CardLoadError({
  error,
  what,
  onRetry,
  retryLabel,
  retryDisabled = false,
  className,
}: {
  error: unknown;
  /** 失败的那件事，已翻译、不带原因与句末标点：「无法加载通行密钥」。 */
  what: string;
  onRetry: () => void;
  /** 重试按钮的文案；不给就用通用的「重试」。 */
  retryLabel?: string;
  retryDisabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription className="flex min-w-0 flex-wrap items-center gap-3">
        <FailureNotice
          failure={describeFailure(error, { t, what })}
          onRetry={onRetry}
          retryLabel={retryLabel}
          retryDisabled={retryDisabled}
        />
      </AlertDescription>
    </Alert>
  );
}
