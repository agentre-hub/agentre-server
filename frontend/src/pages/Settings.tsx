import * as React from "react";
import {
  AgentBackendsPanel,
  LlmProvidersPanel,
  Alert,
  AlertDescription,
  Button,
} from "@agentre-hub/agentre-ui";
import { Cloud, Laptop } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import AppShell from "@/components/AppShell";
import { ActivityStatsPanel } from "@/components/settings/ActivityStatsPanel";
import PageTitle from "@/components/PageTitle";
import { EmptyState } from "@/components/console";
import { useAliveEffect } from "@/hooks/use-alive-effect";
import { fetchDevices, type DeviceItem } from "@/lib/devices";
import {
  createBrowserEngineSettingsPorts,
  isExecutionDevice,
} from "@/lib/enginePorts";

const SECTIONS = ["providers", "backends", "privacy"] as const;
type Section = (typeof SECTIONS)[number];

function sectionFromParam(value: string | null): Section {
  return (SECTIONS as readonly string[]).includes(value ?? "")
    ? (value as Section)
    : "providers";
}

export default function Settings() {
  const { t } = useTranslation();
  // 总览的「统计设置 →」与「开启完整活跃统计 →」都指到 ?tab=privacy —— 一条深链
  // 落到默认页签上，等于把用户扔在离目标两步远的地方，而他刚刚已经点过一次了。
  const [searchParams] = useSearchParams();
  const [section, setSection] = React.useState<Section>(() =>
    sectionFromParam(searchParams.get("tab")),
  );
  // 能跑 Agent 后端的机器有几台。null = 还没读到 / 读失败——那是「不知道」，
  // 不是「你没有设备」，此时照常把面板交出去，别拿一个猜测挡住整页。

  // 两个计数只是标题下的一行说明：取不到就保持 null（那一行不渲染），不挡整页。
  const [loadedDevices, setLoadedDevices] = React.useState<DeviceItem[] | null>(
    null,
  );
  useAliveEffect((alive) => {
    fetchDevices()
      .then((list) => alive() && setLoadedDevices(list))
      .catch(() => alive() && setLoadedDevices(null));
  }, []);
  const syncedDevices =
    loadedDevices?.filter(
      (device) => device.kind !== "web" && device.kind !== "browser",
    ).length ?? null;
  const executionDevices =
    loadedDevices?.filter((device) => isExecutionDevice(device.kind)).length ??
    null;

  const ports = React.useMemo(() => {
    // Hermes 结构化失败码 → 可读句子。键集合与 agentre-ui 的
    // agentBackends.hermes.errors.* 同源（同一份 wire 结果码），但这里必须自成
    // 一份：那份翻译是共享包内部模块，不在 index.ts 的导出面上，而中继失败要
    // 显示的文本必须在抛错那一刻就是成句的话（enginePorts.ts 的
    // credentialErrorReason 文档写明了原因）。未知或空 code——中继/传输层失败，
    // 或 OpenClaw token 写入这类完全没有 code 字段的失败——落到 unknown 兜底。
    const credentialErrorMessages: Record<string, string> = {
      HERMES_LOGIN_REQUIRED: t(
        "settings.errors.credential.HERMES_LOGIN_REQUIRED",
      ),
      HERMES_LOGIN_EXPIRED: t(
        "settings.errors.credential.HERMES_LOGIN_EXPIRED",
      ),
      HERMES_INVALID_CREDENTIALS: t(
        "settings.errors.credential.HERMES_INVALID_CREDENTIALS",
      ),
      HERMES_RATE_LIMITED: t("settings.errors.credential.HERMES_RATE_LIMITED"),
      HERMES_PROVIDER_UNSUPPORTED: t(
        "settings.errors.credential.HERMES_PROVIDER_UNSUPPORTED",
      ),
      HERMES_PROVIDER_UNAVAILABLE: t(
        "settings.errors.credential.HERMES_PROVIDER_UNAVAILABLE",
      ),
      HERMES_PROVIDER_NOT_FOUND: t(
        "settings.errors.credential.HERMES_PROVIDER_NOT_FOUND",
      ),
      HERMES_UNREACHABLE: t("settings.errors.credential.HERMES_UNREACHABLE"),
    };
    return createBrowserEngineSettingsPorts({
      noOnlineAgentredReason: t("settings.errors.noOnlineAgentred"),
      builtinUnsupportedReason: t("settings.errors.builtinUnsupported"),
      unsupportedBackendReason: t("settings.errors.unsupportedBackend"),
      deviceRequiredReason: t("settings.errors.deviceRequired"),
      deviceOfflineReason: t("settings.errors.deviceOffline"),
      deviceUnknownReason: t("settings.errors.deviceUnknown"),
      credentialErrorReason: (code) =>
        credentialErrorMessages[code] ??
        t("settings.errors.credential.unknown"),
    });
  }, [t]);

  const renderHeader = (actions: React.ReactNode) => (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <PageTitle>{t("settings.title")}</PageTitle>
        {syncedDevices !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("settings.syncStatus", { count: syncedDevices })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );

  return (
    <AppShell title={t("nav.settings")}>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <div
          role="tablist"
          aria-label={t("settings.title")}
          className="flex flex-wrap gap-2"
        >
          {SECTIONS.map((key) => (
            <Button
              key={key}
              type="button"
              role="tab"
              aria-selected={section === key}
              variant={section === key ? "default" : "outline"}
              size="sm"
              onClick={() => setSection(key)}
            >
              {t(`settings.tabs.${key}`)}
            </Button>
          ))}
        </div>

        {syncedDevices === 0 && section !== "privacy" ? (
          <Alert>
            <Cloud aria-hidden="true" />
            <AlertDescription>{t("settings.offlineNotice")}</AlertDescription>
          </Alert>
        ) : null}

        <section
          role="tabpanel"
          aria-label={t(`settings.sections.${section}`)}
          className="flex min-w-0 flex-col gap-3"
        >
          {section === "privacy" ? (
            <>
              {renderHeader(null)}
              <ActivityStatsPanel />
            </>
          ) : section === "providers" ? (
            <LlmProvidersPanel
              ports={ports}
              onOpenAgentBackends={() => setSection("backends")}
              renderHeader={renderHeader}
            />
          ) : executionDevices === 0 ? (
            // 后端必须跑在一台机器上（规格决策 5/10）：账号里一台都没有时，
            // 这一页不摆一个按了必然失败的「新建」，改指路去登记设备。
            // LLM 供应商页与机器无关，不受此限。
            <>
              {renderHeader(null)}
              <div className="rounded-lg border border-border bg-card">
                <EmptyState
                  icon={Laptop}
                  testId="settings-backends-no-device"
                  title={t("settings.backendsNoDevice.title")}
                  body={t("settings.backendsNoDevice.body")}
                  action={
                    <Button asChild size="sm">
                      <Link to="/devices">
                        {t("settings.backendsNoDevice.action")}
                      </Link>
                    </Button>
                  }
                />
              </div>
            </>
          ) : (
            <AgentBackendsPanel
              ports={ports}
              onOpenLlmProviders={() => setSection("providers")}
              renderHeader={renderHeader}
            />
          )}
        </section>
      </div>
    </AppShell>
  );
}
