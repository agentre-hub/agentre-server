import { useTranslation } from "react-i18next";

import AuthLayout from "@/components/AuthLayout";

/** /terms、/privacy、/status 共用的占位页：同一套外壳，只换标题。 */
const TITLE_KEY = {
  terms: "authLayout.footer.terms",
  privacy: "authLayout.footer.privacy",
  status: "authLayout.footer.status",
} as const;

export default function ComingSoon({ page }: { page: keyof typeof TITLE_KEY }) {
  const { t } = useTranslation();
  return (
    <AuthLayout>
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold text-foreground">
          {t(TITLE_KEY[page])}
        </h1>
        <p className="text-muted-foreground">{t("legal.comingSoon")}</p>
      </div>
    </AuthLayout>
  );
}
