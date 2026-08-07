import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import AuthLayout from "@/components/AuthLayout";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <AuthLayout>
      <div className="space-y-2 text-center">
        <h1 className="text-4xl font-bold">{t("notFound.title")}</h1>
        <p className="text-muted-foreground">{t("notFound.body")}</p>
        <Link to="/" className="underline">
          {t("common.back_home")}
        </Link>
      </div>
    </AuthLayout>
  );
}
