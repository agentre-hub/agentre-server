import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TimerOff } from "lucide-react";

import { buttonVariants } from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";
import { useIsMobile } from "@/components/use-is-mobile";

/**
 * 终态页：设备码在授权完成前过期（决策 9）——`ApiError.code === 30202`，
 * 或确认屏倒计时归零。导航到这条路由由 /device 负责，本任务只落地这条
 * 路由本身能不能独立打开、独立工作。
 */
export default function DeviceExpired() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  // 手机：照拒绝页——图标 + 标题 + 说明居中，「重新输入代码」钉底，没有卡片与页脚。
  if (mobile) {
    return (
      <AuthLayout
        pinned={
          <Link
            to="/device"
            className={buttonVariants({ className: "h-11 w-full" })}
          >
            {t("device.expiredScreen.retry")}
          </Link>
        }
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex size-[60px] items-center justify-center rounded-full bg-status-waiting-bg">
            <TimerOff
              className="size-6 text-status-waiting"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-2">
            <PageTitle>{t("device.expiredScreen.title")}</PageTitle>
            <p className="text-sm text-muted-foreground">
              {t("device.expiredScreen.body")}
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <div className="flex w-full max-w-[28rem] flex-col items-center gap-6 rounded-2xl bg-sheet p-6 text-center shadow-overlay sm:p-10">
        <div className="flex size-[60px] items-center justify-center rounded-full bg-status-waiting-bg">
          <TimerOff className="size-6 text-status-waiting" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <PageTitle>{t("device.expiredScreen.title")}</PageTitle>
          <p className="text-sm text-muted-foreground">
            {t("device.expiredScreen.body")}
          </p>
        </div>
        <Link to="/device" className={buttonVariants({ className: "w-full" })}>
          {t("device.expiredScreen.retry")}
        </Link>
      </div>
    </AuthLayout>
  );
}
