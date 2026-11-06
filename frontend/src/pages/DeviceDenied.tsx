import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CircleSlash } from "lucide-react";

import { buttonVariants } from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";
import { useIsMobile } from "@/components/use-is-mobile";

/**
 * 终态页：用户主动拒绝了这次设备授权（决策 9）。
 * 中性收尾，不用 destructive 色——这是用户自己的选择，不是一次报错
 * （spec「失败路径」原话：「这一屏是中性收尾，不使用 destructive 色」；
 * 画板 18 的那张缩略卡画的是红圈，以 spec 为准）。导航到这条路由由 /device
 * 的拒绝流程负责，本任务只落地这条路由本身能不能独立打开、独立工作。
 */
export default function DeviceDenied() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  // 手机：图标 + 标题 + 一句说明居中，两个去处钉底。
  if (mobile) {
    return (
      <AuthLayout
        pinned={
          <>
            <Link
              to="/device"
              className={buttonVariants({ className: "h-11 w-full" })}
            >
              {t("device.deniedScreen.retry")}
            </Link>
            <Link
              to="/overview"
              className={buttonVariants({
                variant: "outline",
                className: "h-11 w-full",
              })}
            >
              {t("device.deniedScreen.console")}
            </Link>
          </>
        }
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex size-[60px] items-center justify-center rounded-full bg-code-surface">
            <CircleSlash
              className="size-6 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-2">
            <PageTitle>{t("device.deniedScreen.title")}</PageTitle>
            <p className="text-sm text-muted-foreground">
              {t("device.deniedScreen.body")}
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <div className="flex w-full max-w-[28rem] flex-col items-center gap-6 rounded-2xl bg-sheet p-6 text-center shadow-overlay sm:p-10">
        {/* 底板取 code-surface 而不是 muted：muted 的深色值与 card 相同，
            那一圈在深色下会整个消失。 */}
        <div className="flex size-[60px] items-center justify-center rounded-full bg-code-surface">
          <CircleSlash
            className="size-6 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <div className="space-y-2">
          <PageTitle>{t("device.deniedScreen.title")}</PageTitle>
          <p className="text-sm text-muted-foreground">
            {t("device.deniedScreen.body")}
          </p>
        </div>
        <Link to="/device" className={buttonVariants({ className: "w-full" })}>
          {t("device.deniedScreen.retry")}
        </Link>
        <Link
          to="/overview"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t("device.deniedScreen.console")}
        </Link>
      </div>
    </AuthLayout>
  );
}
