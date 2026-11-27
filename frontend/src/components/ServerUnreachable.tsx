import { CloudOff, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, Spinner } from "@agentre-hub/agentre-ui";
import { EmptyState } from "@/components/console";

/**
 * 没有本地身份、又取不到 /v1/auth/me 时的整屏（规格 2026-11-25 决策 A3，对比稿 d1 B）。
 *
 * 不去登录页：断网、超时、5xx、门户页都不等于「没登录」。自动重试由身份模块退避着跑，
 * 这里只把「第几次了」说出来，并给一颗「立即重试」；取到身份 RequireAuth 自己放行。
 * 一次核对在飞时按钮禁用——不然第二次失败在屏上什么都不变，人只会接着点。
 */
export function ServerUnreachable({
  attempt,
  inFlight,
  onRetry,
}: {
  attempt: number;
  inFlight: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="server-unreachable"
      className="flex min-h-dvh items-center justify-center px-4 pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]"
    >
      <EmptyState
        icon={CloudOff}
        tone="warn"
        title={t("common.serverUnreachable.title")}
        body={t("common.serverUnreachable.body")}
        action={
          <div className="flex w-full max-w-xs flex-col items-center gap-3">
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <Spinner
                aria-hidden="true"
                role="presentation"
                className="size-3.5"
              />
              {t("common.serverUnreachable.retrying", { n: attempt })}
            </p>
            <Button
              type="button"
              className="h-11 w-full"
              disabled={inFlight}
              onClick={onRetry}
            >
              <RefreshCw aria-hidden="true" />
              {t("common.serverUnreachable.retryNow")}
            </Button>
          </div>
        }
      />
    </div>
  );
}
