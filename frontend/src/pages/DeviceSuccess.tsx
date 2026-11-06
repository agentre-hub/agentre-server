import { Link, useLocation } from "react-router-dom";
import { Check, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  AgentredInstallDocsLink,
  AgentredServiceSection,
  GuideStepRail,
  buttonVariants,
  type AgentredInstallMethod,
  type GuideStep,
} from "@agentre-hub/agentre-ui";
import AuthLayout from "@/components/AuthLayout";
import PageTitle from "@/components/PageTitle";
import { useIsMobile } from "@/components/use-is-mobile";
import { DEVICE_KIND_ICONS, deviceKindLabel } from "@/lib/deviceKind";

/**
 * 授权批准那一步（`/device` 拿到的 pending 记录）已经知道的设备信息，
 * 靠 router state 带到这一屏——不落 URL、不落 storage，刷新或直接访问
 * 这条路由时天然拿不到，此时整块面板不渲染（决策 13）。
 *
 * `method` 只在从「添加设备」引导来时才有；CLI 直接打开的授权没有这个信息。
 */
export interface DeviceSuccessInfo {
  kind: string;
  platform: string;
  version: string;
  /** 设备自报的主机名；缺省或空串时标题回退为类型名。 */
  name?: string;
  method?: AgentredInstallMethod;
}

const STEP_KEYS = ["login", "code", "service"] as const;
/** 走到这一屏，前两步（登录、批准）必然已经完成。 */
const DONE_STEPS = [1, 2];

function readDeviceInfo(state: unknown): DeviceSuccessInfo | null {
  const info = state as
    (Partial<DeviceSuccessInfo> & { from?: unknown }) | null | undefined;
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
  return {
    kind: info.kind,
    platform: info.platform,
    version: info.version,
    name: typeof info.name === "string" ? info.name : undefined,
    method:
      info.from === "add-guide" &&
      (info.method === "native" || info.method === "docker")
        ? info.method
        : undefined,
  };
}

export default function DeviceSuccess() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const { state } = useLocation();
  const info = readDeviceInfo(state);
  // 只有拿到了设备信息、且确是 agentred，才有「第 3 步」可给。
  const finishService = info?.kind === "agentred";

  const steps: readonly GuideStep[] = STEP_KEYS.map((key) => ({
    key,
    title: t(`device.add.steps.${key}.title`),
    hint: t(`device.add.steps.${key}.hint`),
    doneLabel: t(`device.add.steps.${key}.done`),
  }));

  const KindIcon = DEVICE_KIND_ICONS[info?.kind ?? ""] ?? Cpu;
  const kindLabel = info ? deviceKindLabel(info.kind, t) : "";
  const title = info?.name || kindLabel;
  // 引导里选过方式就用它；CLI 直开没有方式信息，默认 native + 说明链接。
  const method: AgentredInstallMethod = info?.method ?? "native";

  // 手机：一屏。紧凑步骤条 → 标题 → 一句正文 → 一张命令卡，「完成」钉底；
  // 不再列设备卡、查看状态与重启两张卡。
  if (mobile) {
    return (
      <AuthLayout
        pinned={
          <Link
            to="/devices"
            className={buttonVariants({
              variant: finishService ? "default" : "outline",
              className: "h-11 w-full",
            })}
          >
            {finishService
              ? t("device.success.finish")
              : t("device.success.manageDevices")}
          </Link>
        }
      >
        <div className="flex flex-col gap-5 pt-2">
          {finishService && (
            <div className="w-full overflow-hidden rounded-lg bg-field-fill">
              <GuideStepRail
                steps={steps}
                current={3}
                done={DONE_STEPS}
                onSelect={() => {}}
                compact
              />
            </div>
          )}
          <div className="space-y-2">
            <PageTitle>{t("device.success.title")}</PageTitle>
            <p className="text-sm text-muted-foreground">
              {finishService
                ? t("device.success.serviceBody")
                : t("device.success.body")}
            </p>
          </div>
          {finishService && (
            <AgentredServiceSection
              method={method}
              compact
              serviceTestId="device-success-command-service"
              serviceCopyTestId="device-success-copy-service"
            />
          )}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex w-full max-w-[28rem] flex-col items-center gap-6 rounded-2xl bg-sheet p-6 text-center shadow-overlay sm:p-10">
        {/* agentred 的引导次序：步骤条 → 标题 + 一句正文 → 命令卡（规格 W1）。 */}
        {finishService && (
          <div className="w-full overflow-hidden rounded-lg bg-field-fill text-left">
            <GuideStepRail
              steps={steps}
              current={3}
              done={DONE_STEPS}
              onSelect={() => {}}
            />
          </div>
        )}
        <div className="flex size-[60px] items-center justify-center rounded-full bg-status-running-bg">
          <Check className="size-6 text-status-running" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <PageTitle>{t("device.success.title")}</PageTitle>
          <p className="text-sm text-muted-foreground">
            {finishService
              ? t("device.success.serviceBody")
              : t("device.success.body")}
          </p>
        </div>
        {info && (
          <div className="flex w-full items-center gap-3 rounded-md bg-code-surface p-4 text-left">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-sheet">
              <KindIcon
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {title}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {`${info.platform} · ${info.version}`}
              </p>
            </div>
          </div>
        )}
        {finishService ? (
          <div className="flex w-full flex-col gap-4 text-left">
            <AgentredServiceSection
              method={method}
              serviceTestId="device-success-command-service"
              serviceCopyTestId="device-success-copy-service"
            />
            {!info?.method && (
              <AgentredInstallDocsLink
                method={method}
                testId="device-success-docs-link"
              />
            )}
            <Link
              to="/devices"
              className={buttonVariants({ className: "w-full" })}
            >
              {t("device.success.finish")}
            </Link>
          </div>
        ) : (
          <Link
            to="/devices"
            className={buttonVariants({
              variant: "outline",
              className: "w-full",
            })}
          >
            {t("device.success.manageDevices")}
          </Link>
        )}
      </div>
    </AuthLayout>
  );
}
