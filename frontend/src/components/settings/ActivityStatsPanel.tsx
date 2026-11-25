import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, MessagesSquare, X } from "lucide-react";

import {
  Button,
  Checkbox,
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
  Skeleton,
  Switch,
  cn,
} from "@agentre-hub/agentre-ui";

import { CardLoadError } from "@/components/console";
import { ConfirmSheet } from "@/components/console/ConfirmSheet";
import { useIsMobile } from "@/components/use-is-mobile";
import { useAliveEffect } from "@/hooks/use-alive-effect";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
// 包里同名的那个 formatRelativeTime 收的是 t()，这里要的是按 locale 的 Intl 版本。
import { formatRelativeTime } from "@/lib/sessionView";
import {
  fetchStatsSettings,
  saveStatsSettings,
  type StatsDeviceReport,
  type StatsSettings,
} from "@/lib/stats";

/**
 * 设置 → 隐私 → 活跃统计。
 *
 * 三件事在这一块里必须成立：
 *
 *  1. **开关状态永远来自服务端的回执**，不本地乐观翻转。这个开关的另一半是「删除
 *     服务端已有的日计数」——翻给用户看了、写却失败了，等于告诉他数据已经删了。
 *  2. **两个方向都要一次确认**：开是因为要一并决定回不回填（PUT 的 `backfill`
 *     不该是一个用户没见过的默认值），关是因为它不可逆。
 *  3. **服务端没交出来的东西一律不画**：逐台上报进度、已保存条数都可缺席，缺了
 *     就少一段，不摆一排「未知」。
 */
/**
 * 取数期间摆在正文位置的两张卡壳。
 *
 * 此前这一档整个返回 `null`——页签行和标题之下一个像素都没有，两张卡在数据落地时
 * 一次性撑开；而且「还没取到」和「这个账号没有隐私设置」长得一模一样。
 *
 * 骨架自己 `aria-hidden`，「正在取」由外面那层的 `aria-busy` 说。
 */
function ActivityStatsSkeleton() {
  return (
    <div
      data-testid="privacy-activity-skeleton"
      aria-hidden="true"
      className="flex min-w-0 flex-col gap-4"
    >
      {[0, 1].map((card) => (
        <div
          key={card}
          className="flex min-w-0 flex-col gap-3.5 rounded-lg bg-field-fill p-4 sm:p-5"
        >
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="h-4 w-28" />
            <span className="flex-1" />
            {card === 0 ? <Skeleton className="h-5 w-9 rounded-full" /> : null}
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ))}
    </div>
  );
}

export function ActivityStatsPanel({
  refreshSignal = 0,
}: {
  /** 每变一次就静默重读一遍设置（清理完成后刷新「已保存的对话」）。 */
  refreshSignal?: number;
}) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();

  const [settings, setSettings] = useState<StatsSettings | null>(null);
  /** 手动重试用的一次性游标：改它即让取数 effect 重跑一轮。 */
  const [reloadKey, setReloadKey] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<"enable" | "disable" | null>(null);
  // 开启说明框在手机上是浮层：系统返回先关它、停在原页（D1）。关闭确认在手机上是
  // ConfirmSheet，它自己接返回。
  useBackDismiss(confirm === "enable", () => setConfirm(null));
  const [backfill, setBackfill] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 每落地一次写回执就加一：在它之前发出的读，带回的是写之前的状态。 */
  const writeEpoch = useRef(0);

  // 首次读、重试和清理后的重读共用这一轮：新一轮开始，上一轮的结果就不算数，
  // 慢回来的旧读数盖不掉新数。已经有数时是静默重读：不清 settings，读不到就留着旧数。
  useAliveEffect(
    (alive) => {
      const silent = settings !== null;
      const epoch = writeEpoch.current;
      fetchStatsSettings()
        .then((got) => {
          // 读发出之后开关已经写过一次：回执才是现状，这次读数作废。
          if (!alive() || epoch !== writeEpoch.current) return;
          setSettings(got);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          // 读不到就说读不到：给一个猜出来的开关状态，用户会以为上报正开着（或正关着）。
          if (alive() && !silent)
            setLoadError(e ?? new Error("stats settings load failed"));
        });
    },
    [reloadKey, refreshSignal],
  );

  const openConfirm = useCallback((next: "enable" | "disable") => {
    setSaveError(null);
    setBackfill(true);
    setConfirm(next);
  }, []);

  async function submit(enabled: boolean) {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const got = await saveStatsSettings({
        enabled,
        ...(enabled ? { backfill } : {}),
      });
      writeEpoch.current += 1;
      setSettings(got);
      setConfirm(null);
    } catch {
      setSaveError(t("settings.privacy.activity.saveError"));
    } finally {
      setSaving(false);
    }
  }

  if (loadError !== null) {
    // 读不到就说读不到，并给回程：分类、401 的「重新登录」与手机 44px 的「重试」都由
    // CardLoadError 给（规格 G1），不在这里再画一只红框。
    return (
      <CardLoadError
        error={loadError}
        what={t("settings.privacy.activity.loadFailedWhat")}
        onRetry={() => {
          setLoadError(null);
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }
  if (settings === null) {
    return (
      <div data-testid="privacy-activity-loading" aria-busy="true">
        <ActivityStatsSkeleton />
      </div>
    );
  }

  const enabled = settings.activity_stats_enabled;

  return (
    <>
      <section
        data-testid="privacy-activity-panel"
        className="flex min-w-0 flex-col gap-3.5 rounded-lg bg-field-fill p-4 sm:p-5"
      >
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="min-w-0 text-aux font-bold text-foreground">
            {t("settings.privacy.activity.title")}
          </h2>
          <span className="flex-1" />
          <Switch
            aria-label={t("settings.privacy.activity.title")}
            checked={enabled}
            // 手机：开关本体只有 32×18，用伪元素把点按区撑到 44×44（不改外观与布局）。
            className={
              isMobile
                ? "relative after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
                : undefined
            }
            onCheckedChange={(next) => openConfirm(next ? "enable" : "disable")}
          />
        </div>
        <p className="text-xs leading-[1.5] text-muted-foreground">
          {t("settings.privacy.activity.body")}
        </p>
        <p className="text-xs text-muted-foreground">
          {enabled
            ? settings.last_pull_at
              ? t("settings.privacy.activity.statusOnAt", {
                  time: formatRelativeTime(
                    settings.last_pull_at,
                    i18n.resolvedLanguage ?? "en",
                  ),
                })
              : t("settings.privacy.activity.statusOn")
            : t("settings.privacy.activity.statusOff")}
        </p>

        {(settings.devices ?? []).length > 0 ? (
          <ul className="flex min-w-0 flex-col gap-1.5">
            {(settings.devices ?? []).map((device) => (
              <DeviceReportRow
                key={device.device_id}
                device={device}
                today={settings.today}
              />
            ))}
          </ul>
        ) : null}

        {/* 已经关掉的账号没有可关的东西，危险区收起来。 */}
        {enabled ? (
          <div
            data-testid="privacy-danger-zone"
            className="flex min-w-0 flex-wrap items-center gap-3 rounded-md bg-destructive-soft px-3.5 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-destructive-text">
                {t("settings.privacy.activity.danger.title")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("settings.privacy.activity.danger.body")}
              </p>
            </div>
            <Button
              size="xs"
              variant="destructive"
              className={isMobile ? "min-h-11 px-4" : undefined}
              onClick={() => openConfirm("disable")}
            >
              {t("settings.privacy.activity.danger.action")}
            </Button>
          </div>
        ) : null}
      </section>

      <section
        data-testid="privacy-saved-conversations"
        className="flex min-w-0 flex-col gap-2 rounded-lg bg-field-fill p-4 sm:p-5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <MessagesSquare
            aria-hidden="true"
            className="size-[15px] shrink-0 text-muted-foreground"
          />
          <h2 className="min-w-0 text-aux font-bold text-foreground">
            {t("settings.privacy.saved.title")}
          </h2>
          {settings.saved_conversations !== undefined ? (
            <span
              data-testid="privacy-saved-count"
              className="text-xs text-muted-foreground"
            >
              {t("settings.privacy.saved.count", {
                count: settings.saved_conversations,
              })}
            </span>
          ) : null}
        </div>
        <p className="text-xs leading-[1.5] text-muted-foreground">
          {t("settings.privacy.saved.body")}
        </p>
      </section>

      <EnableDialog
        open={confirm === "enable"}
        busy={saving}
        error={saveError}
        backfill={backfill}
        onBackfill={setBackfill}
        onClose={() => setConfirm(null)}
        onSubmit={() => void submit(true)}
      />
      <DisableDialog
        open={confirm === "disable"}
        busy={saving}
        error={saveError}
        onClose={() => setConfirm(null)}
        onSubmit={() => void submit(false)}
      />
    </>
  );
}

/**
 * 一台机器的上报进度。缺席的字段就少说一句，不补一个「未知」。
 *
 * `today` 是**服务端**的今天，由调用方从同一份响应里传下来。不能拿浏览器的今天去比：
 * `reported_through` 按服务端时区切，服务端在 UTC+8 的早上 07:00 时浏览器算出来的今天
 * 还是昨天，一台刚上报完的机器会被显示成「已上报到某个看起来像未来的日期」。
 */
function DeviceReportRow({
  device,
  today,
}: {
  device: StatsDeviceReport;
  today: string;
}) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (device.online) {
    if (device.reported_through && device.reported_through === today) {
      parts.push(t("settings.privacy.activity.deviceReportedToday"));
    } else if (device.reported_through) {
      parts.push(
        t("settings.privacy.activity.deviceReportedThrough", {
          day: device.reported_through,
        }),
      );
    }
  } else {
    parts.push(t("settings.privacy.activity.deviceOffline"));
  }
  const status = parts.join(" · ");
  return (
    <li
      data-testid="privacy-device-row"
      className="flex min-w-0 items-center gap-2"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[6px] shrink-0 rounded-full",
          device.online ? "bg-status-running" : "bg-status-idle",
        )}
      />
      <span className="min-w-0 truncate text-xs text-foreground">
        {device.name}
      </span>
      <span className="flex-1" />
      {status ? (
        <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
      ) : null}
    </li>
  );
}

/** 会 / 不会上报的对照。两栏都是真实清单，不是宣传语。 */
function ReportList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "will" | "wont";
}) {
  const Icon = tone === "will" ? Check : X;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-xs font-semibold text-foreground">{title}</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item} className="flex min-w-0 items-start gap-1.5">
            <Icon
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-3 shrink-0",
                tone === "will"
                  ? "text-status-running"
                  : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 text-xs text-muted-foreground">
              {item}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EnableDialog({
  open,
  busy,
  error,
  backfill,
  onBackfill,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  backfill: boolean;
  onBackfill: (next: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      size="md"
      busy={busy}
    >
      <DialogShellHeader
        title={t("settings.privacy.activity.enable.title")}
        subtitle={t("settings.privacy.activity.enable.body")}
        onClose={onClose}
        busy={busy}
      />
      <DialogShellBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <ReportList
            tone="will"
            title={t("settings.privacy.activity.enable.willReport")}
            items={[
              t("settings.privacy.activity.enable.reportDate"),
              t("settings.privacy.activity.enable.reportDimensions"),
              t("settings.privacy.activity.enable.reportProject"),
            ]}
          />
          <ReportList
            tone="wont"
            title={t("settings.privacy.activity.enable.wontReport")}
            items={[
              t("settings.privacy.activity.enable.neverTitles"),
              t("settings.privacy.activity.enable.neverPaths"),
              t("settings.privacy.activity.enable.neverPrompts"),
            ]}
          />
        </div>
        <div className="flex min-w-0 items-start gap-2.5 rounded-md bg-field-fill p-3">
          <Checkbox
            id="activity-stats-backfill"
            checked={backfill}
            onCheckedChange={(next) => onBackfill(next === true)}
          />
          <div className="min-w-0">
            <label
              htmlFor="activity-stats-backfill"
              className="text-xs font-medium text-foreground"
            >
              {t("settings.privacy.activity.enable.backfill")}
            </label>
            <p className="text-xs text-muted-foreground">
              {t("settings.privacy.activity.enable.backfillHint")}
            </p>
          </div>
        </div>
        <p className="text-2xs text-subtle-foreground">
          {t("settings.privacy.activity.enable.foot")}
        </p>
      </DialogShellBody>
      <DialogShellFooter error={error}>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <DialogShellSubmit busy={busy} onClick={onSubmit}>
          {t("settings.privacy.activity.enable.submit")}
        </DialogShellSubmit>
      </DialogShellFooter>
    </DialogShell>
  );
}

function DisableDialog({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  if (isMobile) {
    // 手机：底部确认 sheet，危险键在上、44px 满宽堆叠（F3）；系统返回即取消（D1）。
    return (
      <ConfirmSheet
        open={open}
        title={t("settings.privacy.activity.disable.title")}
        description={`${t("settings.privacy.activity.disable.body")} ${t("settings.privacy.activity.disable.note")}`}
        error={error}
        onCancel={() => {
          if (!busy) onClose();
        }}
        actions={[
          {
            label: t("settings.privacy.activity.disable.submit"),
            variant: "destructive",
            disabled: busy,
            onSelect: onSubmit,
          },
          {
            label: t("common.cancel"),
            variant: "secondary",
            disabled: busy,
            onSelect: onClose,
          },
        ]}
      />
    );
  }
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      danger
      busy={busy}
    >
      <DialogShellHeader
        danger
        title={t("settings.privacy.activity.disable.title")}
        onClose={onClose}
        busy={busy}
      />
      <DialogShellBody className="flex flex-col gap-2">
        <p className="text-xs leading-[1.5] text-muted-foreground">
          {t("settings.privacy.activity.disable.body")}
        </p>
        <p className="text-xs leading-[1.5] text-muted-foreground">
          {t("settings.privacy.activity.disable.note")}
        </p>
      </DialogShellBody>
      <DialogShellFooter error={error}>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <DialogShellSubmit busy={busy} variant="destructive" onClick={onSubmit}>
          {t("settings.privacy.activity.disable.submit")}
        </DialogShellSubmit>
      </DialogShellFooter>
    </DialogShell>
  );
}
