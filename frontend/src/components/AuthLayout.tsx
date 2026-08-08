import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";

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
          <div className="flex size-7 items-center justify-center rounded-sm bg-primary">
            <SquareTerminal
              className="size-4 text-primary-foreground"
              aria-hidden="true"
            />
          </div>
          <span className="text-[15px] font-semibold text-foreground">
            {t("authLayout.brand")}
          </span>
        </div>
        <div className="flex-1" />
        <AppControls />
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        {children}
      </main>

      <footer className="flex flex-wrap items-center justify-center gap-[18px] px-8 py-5 text-xs text-subtle-foreground">
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
