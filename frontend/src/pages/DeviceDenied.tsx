import { useTranslation } from "react-i18next";
import { CircleSlash } from "lucide-react";

import { Button } from "@/components/ui/button";
import AuthLayout from "@/components/AuthLayout";

/**
 * 终态页：用户主动拒绝了这次设备授权（决策 9）。
 * 中性收尾，不用 destructive 色——这是用户自己的选择，不是一次报错
 * （画板 18 的批注）。导航到这条路由由 /device 的拒绝流程负责，
 * 本任务只落地这条路由本身能不能独立打开、独立工作。
 */
export default function DeviceDenied() {
  const { t } = useTranslation();
  return (
    <AuthLayout>
      <div className="flex w-full max-w-[28rem] flex-col items-center gap-6 rounded-lg border bg-card p-6 text-center sm:p-10">
        <div className="flex size-[60px] items-center justify-center rounded-full bg-destructive-soft">
          <CircleSlash className="size-6 text-destructive" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">
            {t("device.deniedScreen.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("device.deniedScreen.body")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => window.close()}
        >
          {t("device.deniedScreen.close")}
        </Button>
      </div>
    </AuthLayout>
  );
}
