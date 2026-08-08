import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function DeviceSuccess() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="space-y-2 text-center">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold">
          {t("device.success.title")}
          <Check className="size-6 text-primary" aria-hidden="true" />
        </h1>
        <p className="text-muted-foreground">{t("device.success.body")}</p>
        <Link
          to="/devices"
          className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("device.success.manageDevices")}
        </Link>
      </div>
    </div>
  );
}
