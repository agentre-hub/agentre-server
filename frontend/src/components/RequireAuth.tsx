import { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useMe } from "@/hooks/use-me";

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const loc = useLocation();
  const { me, loading, error } = useMe();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }
  if (error || !me) {
    const next = encodeURIComponent(loc.pathname + loc.search);
    window.location.replace(`/login?next=${next}`);
    return null;
  }
  return <>{children}</>;
}
