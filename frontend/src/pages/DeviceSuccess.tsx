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
      </div>
    </div>
  );
}
