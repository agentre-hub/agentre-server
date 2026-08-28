import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { buttonVariants } from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-4 text-center">
        <p
          className="text-7xl font-semibold text-border-strong"
          aria-hidden="true"
        >
          {t("notFound.code")}
        </p>
        <PageTitle>{t("notFound.title")}</PageTitle>
        <p className="text-sm text-muted-foreground">{t("notFound.body")}</p>
        <Link
          to="/"
          className={buttonVariants({ variant: "outline", className: "mt-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("common.back_home")}
        </Link>
      </div>
    </AuthLayout>
  );
}
