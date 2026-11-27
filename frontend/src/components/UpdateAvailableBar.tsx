import { Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, cn } from "@agentre-hub/agentre-ui";
import { useUpdateAvailable } from "@/hooks/use-update-available";

/**
 * 「控制台有新版本 · 重新加载」（规格 2026-11-25 决策 B1，对比稿 d8 B）。
 *
 * 没有新版本时不占位。只在人点「重新加载」时 reload，从不自动刷新；关掉之后下一次
 * 回到前台再出（见 useUpdateAvailable）。两颗按钮都是 44px 高的点按区。
 */
export default function UpdateAvailableBar({
  className,
}: {
  className?: string;
}) {
  const { t } = useTranslation();
  const { available, reload, dismiss } = useUpdateAvailable();
  if (!available) return null;

  return (
    <div
      role="status"
      data-testid="update-available"
      className={cn(
        "flex shrink-0 items-center gap-2 bg-primary-soft pl-4 text-aux text-primary-text",
        className,
      )}
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {t("appShell.update.available")}
      </span>
      <Button
        variant="ghost"
        className="h-11 px-3 font-semibold text-primary-text hover:bg-transparent hover:text-primary-text"
        onClick={reload}
      >
        {t("common.reload")}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 text-primary-text hover:bg-transparent hover:text-primary-text"
        aria-label={t("appShell.update.dismiss")}
        onClick={dismiss}
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
