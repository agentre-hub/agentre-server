import { useTranslation } from "react-i18next";
import { CircleSlash } from "lucide-react";

import { Button } from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";

/**
 * 终态页：用户主动拒绝了这次设备授权（决策 9）。
 * 中性收尾，不用 destructive 色——这是用户自己的选择，不是一次报错
 * （spec「失败路径」原话：「这一屏是中性收尾，不使用 destructive 色」；
 * 画板 18 的那张缩略卡画的是红圈，以 spec 为准）。导航到这条路由由 /device
 * 的拒绝流程负责，本任务只落地这条路由本身能不能独立打开、独立工作。
 */
export default function DeviceDenied() {
  const { t } = useTranslation();
  return (
    <AuthLayout>
      <div className="flex w-full max-w-[28rem] flex-col items-center gap-6 rounded-lg border bg-card p-6 text-center sm:p-10">
        {/* 底板取 code-surface 而不是 muted：muted 的深色值与 card 相同，
            那一圈在深色下会整个消失。 */}
        <div className="flex size-[60px] items-center justify-center rounded-full bg-code-surface">
          <CircleSlash
            className="size-6 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <PageTitle>{t("device.deniedScreen.title")}</PageTitle>
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
