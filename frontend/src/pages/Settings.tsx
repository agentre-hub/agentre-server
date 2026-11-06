import * as React from "react";
import {
  AgentBackendsPanel,
  LlmProvidersPanel,
  Alert,
  AlertDescription,
  Button,
  SegmentedControl,
  SegmentedControlItem,
  cn,
  useTheme,
  type AppThemePreference,
} from "@agentre-hub/agentre-ui";
import { Check, ChevronLeft, ChevronRight, Cloud, Laptop } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import AppShell from "@/components/AppShell";
import { ActivityStatsPanel } from "@/components/settings/ActivityStatsPanel";
import PageTitle from "@/components/PageTitle";
import { EmptyState, MobileNavButton } from "@/components/console";
import { useIsMobile } from "@/components/use-is-mobile";
import { useAccountChannel } from "@/hooks/use-account-channel";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "@/i18n";
import { useAliveEffect } from "@/hooks/use-alive-effect";
import { AccountChannelSyncVersion } from "@/lib/accountChannel";
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

// 手机上的一级列表：每一行进入自己的整屏页（?section=）；供应商详情与后端编辑
// 再多一层（&id=），浏览器的返回键因此逐层退。
const PHONE_SECTIONS = [
  "providers",
  "backends",
  "privacy",
  "appearance",
  "language",
] as const;
type PhoneSection = (typeof PHONE_SECTIONS)[number];

function phoneSectionFromParams(params: URLSearchParams): PhoneSection | null {
  const value = params.get("section") ?? params.get("tab");
  return (PHONE_SECTIONS as readonly string[]).includes(value ?? "")
    ? (value as PhoneSection)
    : null;
}

const PHONE_GROUPS: readonly (readonly PhoneSection[])[] = [
  ["providers", "backends", "privacy"],
  ["appearance", "language"],
];

const THEME_CHOICES: readonly AppThemePreference[] = [
  "system",
  "light",
  "dark",
];

const PHONE_HEADER_CLASS =
  "flex h-[calc(52px_+_env(safe-area-inset-top,0px))] shrink-0 items-center gap-1 bg-chrome px-4 pt-[env(safe-area-inset-top,0px)]";

function ChoiceRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-11 w-full items-center justify-between gap-3 bg-field-fill px-4 text-left text-sm text-foreground",
        "outline-none hover:bg-rail-accent focus-visible:focus-outline",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      {selected ? (
        <Check className="size-4 text-primary" aria-hidden="true" />
      ) : null}
    </button>
  );
}

function AppearancePage() {
  const { t } = useTranslation();
  const { themePreference, setThemePreference } = useTheme();
  const labels: Record<AppThemePreference, string> = {
    system: t("settings.theme.system"),
    light: t("settings.theme.light"),
    dark: t("settings.theme.dark"),
  };
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.sections.appearance")}
      className="flex flex-col gap-0.5 overflow-hidden rounded-lg"
    >
      {THEME_CHOICES.map((choice) => (
        <ChoiceRow
          key={choice}
          label={labels[choice]}
          selected={themePreference === choice}
          onSelect={() => setThemePreference(choice)}
        />
      ))}
    </div>
  );
}

function LanguagePage() {
  const { t, i18n } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t("settings.sections.language")}
      className="flex flex-col gap-0.5 overflow-hidden rounded-lg"
    >
      {SUPPORTED_LANGUAGES.map((lang) => (
        <ChoiceRow
          key={lang}
          label={LANGUAGE_LABELS[lang]}
          selected={i18n.resolvedLanguage === lang}
          onSelect={() => void i18n.changeLanguage(lang)}
        />
      ))}
    </div>
  );
}

export default function Settings() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  // 总览的「统计设置 →」与「开启完整活跃统计 →」都指到 ?tab=privacy —— 一条深链
  // 落到默认页签上，等于把用户扔在离目标两步远的地方，而他刚刚已经点过一次了。
  const [searchParams, setSearchParams] = useSearchParams();
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

  // 供应商/后端是同步对象，其它设备写入会推账号通道的同步版本信号（Problem 9：
  // 页面停留期间不跟着刷新的话，浏览器缓存的陈旧状态会在下一次保存时把它们的
  // 改动撤回）。两个面板各自只在 refreshSignal 变化时重拉列表，且不打断正在
  // 打开的编辑弹窗（共享包 D5 已经测过这一半）；这里只需要把信号接上去。
  const [refreshSignal, setRefreshSignal] = React.useState(0);
  useAccountChannel([AccountChannelSyncVersion], () =>
    setRefreshSignal((value) => value + 1),
  );

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

  if (isMobile) {
    const phoneSection = phoneSectionFromParams(searchParams);
    const rawId = searchParams.get("id");
    const go = (next: Record<string, string>) => setSearchParams(next);
    const sectionTitle = phoneSection
      ? t(`settings.sections.${phoneSection}`)
      : t("settings.title");
    // 后端编辑页自带 ✕ / 标题 / 保存的页头，外壳这里不再叠一条。
    const editorOwnsHeader = phoneSection === "backends" && rawId !== null;
    const showOfflineNotice =
      syncedDevices === 0 && phoneSection === "providers";
    const phoneActions = (actions: React.ReactNode) =>
      actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      ) : null;

    let body: React.ReactNode;
    if (phoneSection === null) {
      body = (
        <div className="flex flex-col gap-4">
          {PHONE_GROUPS.map((group) => (
            <div
              key={group.join()}
              className="flex flex-col gap-0.5 overflow-hidden rounded-lg"
            >
              {group.map((key) => (
                <Link
                  key={key}
                  to={{ search: `?section=${key}` }}
                  className="flex min-h-11 items-center justify-between gap-3 bg-field-fill px-4 text-sm text-foreground outline-none hover:bg-rail-accent focus-visible:focus-outline"
                >
                  <span className="min-w-0 truncate">
                    {t(`settings.sections.${key}`)}
                  </span>
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          ))}
        </div>
      );
    } else if (phoneSection === "privacy") {
      body = <ActivityStatsPanel />;
    } else if (phoneSection === "appearance") {
      body = <AppearancePage />;
    } else if (phoneSection === "language") {
      body = <LanguagePage />;
    } else if (phoneSection === "providers") {
      const id = rawId !== null && rawId !== "" ? Number(rawId) : null;
      body = (
        <LlmProvidersPanel
          ports={ports}
          refreshSignal={refreshSignal}
          layer={id !== null && Number.isFinite(id) ? "detail" : "list"}
          selectedId={id !== null && Number.isFinite(id) ? id : null}
          onSelect={(next) =>
            go(
              next === null
                ? { section: "providers" }
                : { section: "providers", id: String(next) },
            )
          }
          onOpenAgentBackends={() => go({ section: "backends" })}
          renderHeader={phoneActions}
        />
      );
    } else if (executionDevices === 0) {
      body = (
        <div className="rounded-lg bg-field-fill">
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
      );
    } else {
      const target =
        rawId === "new"
          ? "new"
          : rawId !== null && rawId !== "" && Number.isFinite(Number(rawId))
            ? Number(rawId)
            : null;
      body = (
        <AgentBackendsPanel
          ports={ports}
          listCLIModels={ports.listCLIModels}
          refreshSignal={refreshSignal}
          layer={target === null ? "list" : "editor"}
          selectedId={target}
          onSelect={(next) =>
            go(
              next === null
                ? { section: "backends" }
                : { section: "backends", id: String(next) },
            )
          }
          onOpenLlmProviders={() => go({ section: "providers" })}
          renderHeader={phoneActions}
        />
      );
    }

    return (
      <AppShell ownHeader title={t("nav.settings")}>
        <div className="flex min-h-0 w-full flex-1 flex-col">
          {editorOwnsHeader ? null : (
            <header
              data-testid="settings-header"
              className={PHONE_HEADER_CLASS}
            >
              {phoneSection === null ? (
                <MobileNavButton />
              ) : (
                <button
                  type="button"
                  aria-label={t("appShell.drawer.back")}
                  onClick={() =>
                    go(
                      rawId !== null && phoneSection !== null
                        ? { section: phoneSection }
                        : {},
                    )
                  }
                  className="relative -ml-2 flex size-11 shrink-0 items-center justify-center rounded-md text-foreground outline-none hover:bg-rail-accent focus-visible:focus-outline"
                >
                  <ChevronLeft className="size-5" aria-hidden="true" />
                </button>
              )}
              <h1 className="min-w-0 truncate text-prose font-bold text-foreground">
                {sectionTitle}
              </h1>
            </header>
          )}
          <div className="flex min-w-0 flex-col gap-3 px-4 pb-4 pt-2">
            {showOfflineNotice ? (
              <Alert>
                <Cloud aria-hidden="true" />
                <AlertDescription>
                  {t("settings.offlineNotice")}
                </AlertDescription>
              </Alert>
            ) : null}
            {body}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={t("nav.settings")}>
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <SegmentedControl
          aria-label={t("settings.title")}
          value={section}
          onValueChange={(next) => setSection(sectionFromParam(next))}
          className="flex-wrap self-start"
        >
          {SECTIONS.map((key) => (
            <SegmentedControlItem key={key} value={key}>
              {t(`settings.tabs.${key}`)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>

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
              refreshSignal={refreshSignal}
              onOpenAgentBackends={() => setSection("backends")}
              renderHeader={renderHeader}
            />
          ) : executionDevices === 0 ? (
            // 后端必须跑在一台机器上（规格决策 5/10）：账号里一台都没有时，
            // 这一页不摆一个按了必然失败的「新建」，改指路去登记设备。
            // LLM 供应商页与机器无关，不受此限。
            <>
              {renderHeader(null)}
              <div className="rounded-lg bg-field-fill">
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
              listCLIModels={ports.listCLIModels}
              refreshSignal={refreshSignal}
              onOpenLlmProviders={() => setSection("providers")}
              renderHeader={renderHeader}
            />
          )}
        </section>
      </div>
    </AppShell>
  );
}
