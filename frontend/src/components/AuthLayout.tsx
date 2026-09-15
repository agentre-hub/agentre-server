import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { agentreLogoUrl } from "@agentre-hub/agentre-ui";

import AppControls from "@/components/AppControls";

/**
 * 认证流与 404 共用的三段外壳：品牌顶栏 / 居中主区 / 页脚。
 *
 * 顶栏在文档流里（不再是 AppControls 过去那个 `fixed` 悬浮层），
 * 主区双向居中且只设 min-h-screen（不是 h-screen），
 * 内容比视口高时页面自然从顶部往下排、整页滚动，不会被裁掉。
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center px-8 py-5">
        <div className="flex items-center gap-[9px]">
          {/* 跟侧边栏 Brand 带同一份共享 mark，不套底板：登录页是没登录的人第一眼
              看到的界面，摆个通用终端图标等于第一眼就不是这个产品；而那块实心底色
              在这一页会成为仅次于主按钮的第二亮元素，跟 CTA 抢。 */}
          <img
            src={agentreLogoUrl}
            alt=""
            aria-hidden="true"
            className="size-7 shrink-0 object-contain"
            draggable={false}
          />
          <span className="text-prose font-semibold text-foreground">
            {t("authLayout.brand")}
          </span>
        </div>
        <div className="flex-1" />
        <AppControls />
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        {children}
      </main>

      <footer className="flex flex-wrap items-center justify-center gap-[18px] px-8 py-5 text-xs text-muted-foreground">
        <span>{t("authLayout.footer.copyright", { year })}</span>
        <Link
          to="/terms"
          className="underline-offset-4 hover:text-foreground hover:underline"
        >
          {t("authLayout.footer.terms")}
        </Link>
        <Link
          to="/privacy"
          className="underline-offset-4 hover:text-foreground hover:underline"
        >
          {t("authLayout.footer.privacy")}
        </Link>
        <Link
          to="/status"
          className="underline-offset-4 hover:text-foreground hover:underline"
        >
          {t("authLayout.footer.status")}
        </Link>
      </footer>
    </div>
  );
}
