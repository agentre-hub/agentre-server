import { useTranslation } from "react-i18next";

import AuthLayout, { AuthMobileHeader } from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";
import { useMobileBack } from "@/components/console/MobileNav";
import { useIsMobile } from "@/components/use-is-mobile";

/** /terms、/privacy、/status 共用的占位页：同一套外壳，只换标题。 */
const TITLE_KEY = {
  terms: "authLayout.footer.terms",
  privacy: "authLayout.footer.privacy",
  status: "authLayout.footer.status",
} as const;

export default function ComingSoon({ page }: { page: keyof typeof TITLE_KEY }) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  // ‹ = 回到上一处（D3）：从登录页点进来就退一步，登录页的 next / user_code 原样留着；
  // 直接打开的以替换回登录页。
  const back = useMobileBack();
  return (
    <AuthLayout
      header={
        mobile ? (
          <AuthMobileHeader
            to="/login"
            icon="back"
            label={t("authLayout.back")}
            title={t(TITLE_KEY[page])}
            onBack={() => back("/login")}
          />
        ) : undefined
      }
    >
      <div className="space-y-2 text-center">
        <PageTitle>{t(TITLE_KEY[page])}</PageTitle>
        <p className="text-muted-foreground">{t("legal.comingSoon")}</p>
        {page === "privacy" ? (
          <p className="max-w-xl text-sm text-muted-foreground">
            {t("legal.privacyEngineKeys")}
          </p>
        ) : null}
      </div>
    </AuthLayout>
  );
}
