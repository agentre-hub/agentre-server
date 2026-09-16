import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, Button } from "@agentre-hub/agentre-ui";

import { ApiError } from "@/lib/api";

/**
 * 卡片读取失败：说出原因，并给一条回程。
 *
 * 没有这颗按钮的话，用户唯一的出路是刷新整页——而这一页另外两张卡此刻可能好好的。
 * 三处消费（`/account` 的两张卡、设备详情、总览统计）此前各写一遍同一条
 * destructive Alert + 文案 + 弹簧 + 重试按钮，收成一份。
 *
 * 文案取 `ApiError.message`（服务端带了业务文案就用它），否则落到调用方给的兜底句。
 */
export function CardLoadError({
  error,
  fallback,
  onRetry,
  retryLabel,
  retryDisabled = false,
  className,
}: {
  error: unknown;
  fallback: string;
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
        <span className="min-w-0">
          {error instanceof ApiError ? error.message : fallback}
        </span>
        <span className="flex-1" />
        <Button
          size="xs"
          variant="outline"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          {retryLabel ?? t("common.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
