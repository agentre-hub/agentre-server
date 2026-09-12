import { Link, useLocation } from "react-router-dom";
import { Check, Laptop } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buttonVariants } from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";
import { deviceKindLabel } from "@/lib/deviceKind";

/**
 * 授权批准那一步（`/device` 拿到的 pending 记录）已经知道的设备信息，
 * 靠 router state 带到这一屏——不落 URL、不落 storage，刷新或直接访问
 * 这条路由时天然拿不到，此时整块面板不渲染（决策 13）。
 */
export interface DeviceSuccessInfo {
  kind: string;
  platform: string;
  version: string;
}

function readDeviceInfo(state: unknown): DeviceSuccessInfo | null {
  const info = state as Partial<DeviceSuccessInfo> | null | undefined;
  if (
    !info ||
    typeof info.kind !== "string" ||
    info.kind === "" ||
    typeof info.platform !== "string" ||
    info.platform === "" ||
    typeof info.version !== "string" ||
    info.version === ""
  ) {
    return null;
  }
  return { kind: info.kind, platform: info.platform, version: info.version };
}

export default function DeviceSuccess() {
  const { t } = useTranslation();
  const { state } = useLocation();
  const info = readDeviceInfo(state);

  return (
    <AuthLayout>
      <div className="flex w-full max-w-[28rem] flex-col items-center gap-6 rounded-lg border bg-card p-6 text-center sm:p-10">
        <div className="flex size-[60px] items-center justify-center rounded-full bg-status-running-bg">
          <Check className="size-6 text-status-running" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <PageTitle>{t("device.success.title")}</PageTitle>
          <p className="text-sm text-muted-foreground">
            {t("device.success.body")}
          </p>
        </div>
        {info && (
          <div className="flex w-full items-center gap-3 rounded-md bg-code-surface p-4 text-left">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-card">
              <Laptop
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                {deviceKindLabel(info.kind, t)}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {`${info.platform} · ${info.version}`}
              </p>
            </div>
          </div>
        )}
        <Link
          to="/devices"
          className={buttonVariants({
            variant: "outline",
            className: "w-full",
          })}
        >
          {t("device.success.manageDevices")}
        </Link>
      </div>
    </AuthLayout>
  );
}
