import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";

import {
  Button,
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  copyTextToClipboard,
  cn,
} from "@agentre-hub/agentre-ui";

import {
  useDeviceUpgrade,
  type UpgradePhase,
} from "@/hooks/use-device-upgrade";
import {
  agentredVersionState,
  type AgentredVersionState,
} from "@/lib/agentredVersion";
import type { DeviceItem } from "@/lib/devices";

/**
 * 设备卡上的版本判断与升级出口（规格 2026-09-03「控制台呈现与 latest 来源」）。
 *
 * 与桌面端同构：真版本 + 弱徽标 + 一键升级 + 命令卡兜底。判定不在这里做，它在
 * lib/agentredVersion —— 这里只决定每个状态画成什么样。
 */

/** 那台机器上要跑的命令。与桌面端、命令行是同一条，改这里之前先确认那边也改了。 */
const UPDATE_COMMAND = "agentred update";

export function deviceVersionState(
  device: DeviceItem,
  latest: string,
): AgentredVersionState {
  return agentredVersionState({
    version: device.version,
    protocolMismatch: device.protocol_mismatch,
    commit: device.daemon_commit,
    buildKnown: device.daemon_build_known,
    latest,
  });
}

/**
 * 副行上那段版本文字（决策 17：版本挂在 `平台 · 版本 · 最后在线` 那一行）。
 *
 * 开发构建如实说是开发构建：它自称的版本号（未注入构建变量时是 1.0.0）不可比，
 * 原样摆出来只会让人以为这台机器跑着一个比正式版还新的东西（决策 5）。桌面端的
 * 设备行说的是同一句话（remoteDevices.upgrade.devBuild）—— 两端对同一台机器的
 * 说法必须一致。
 */
export function deviceVersionText(
  state: AgentredVersionState,
  t: (key: string) => string,
): string {
  if (state.kind === "dev-build") return t("device.upgrade.devBuild");
  return state.kind === "unknown" ? "" : state.version;
}

/**
 * 副行上的那枚徽标（决策 17：挂在 `平台 · 版本 · 最后在线` 那一行，不进标题行）。
 *
 * 只有两种情形出徽标：可升级（弱，复用等待色）与协议不匹配（强，复用故障色）。
 * 「已是最新」与「拿不到最新版信息」都不出——后者尤其不能借「没有徽标」冒充前者
 * （决策 19），它们的差别在展开区里说。不新增设计 token（决策 16）。
 */
export function DeviceVersionBadge({
  state,
  deviceID,
}: {
  state: AgentredVersionState;
  deviceID: number;
}) {
  const { t } = useTranslation();
  if (state.kind === "protocol-mismatch") {
    return (
      <span
        data-testid={`device-version-badge-${deviceID}`}
        className="rounded-md bg-destructive-soft px-1.5 py-0.5 text-3xs font-medium text-destructive-text"
      >
        {t("device.upgrade.blockedBadge")}
      </span>
    );
  }
  if (state.kind !== "upgradable") return null;
  return (
    <span
      data-testid={`device-version-badge-${deviceID}`}
      className="rounded-md bg-status-waiting-bg px-1.5 py-0.5 text-3xs font-medium text-status-waiting"
    >
      {t("device.upgrade.badge", { version: state.latest })}
    </span>
  );
}

/** 可复制的 `agentred update`：一键升级够不着时它是唯一出口，因此始终在场。 */
function UpdateCommandCard({ deviceID }: { deviceID: number }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {t("device.upgrade.commandLabel")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          data-testid={`device-upgrade-copy-${deviceID}`}
          onClick={() => {
            copyTextToClipboard(UPDATE_COMMAND)
              .then((ok) => {
                // 没复制成就保持原样：命令本身仍然可以选中手抄，不谎报「已复制」。
                if (ok) setCopied(true);
              })
              .catch(() => {});
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("device.add.copied") : t("device.add.copy")}
        </Button>
      </div>
      <pre
        data-testid={`device-upgrade-command-${deviceID}`}
        className="overflow-x-auto bg-code-surface px-3 py-2.5 font-mono text-xs text-code-foreground"
      >
        {UPDATE_COMMAND}
      </pre>
    </div>
  );
}

/** 主动作的文案与可用性。 */
function actionLabel(
  state: AgentredVersionState,
  phase: UpgradePhase,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { label: string; disabled: boolean; secondary: boolean } {
  // 调用还在飞与升级已受理，主动作是同一件事：不可再点。差别只在它此刻说什么。
  if (phase.kind === "requesting") {
    return {
      label: t("device.upgrade.action.requesting"),
      disabled: true,
      secondary: false,
    };
  }
  if (phase.kind === "upgrading") {
    return {
      label: t("device.upgrade.action.upgrading"),
      disabled: true,
      secondary: false,
    };
  }
  // 有对话在跑：降为次要样式、改口「仍要升级」，但**不禁用** —— 禁用会让一台整天
  // 有对话在跑的机器彻底没有出口，而决策 8 要的是「越过必须显式」，不是「不可越过」
  // （决策 21）。拦截由二次确认承担。
  if (phase.kind === "active-turns") {
    return {
      label: t("device.upgrade.action.forceLabel"),
      disabled: false,
      secondary: true,
    };
  }
  // 开发构建：入口同样保留，但禁用 —— 永不劝升（决策 5），而隐藏入口会让人怀疑
  // 自己记错了位置（决策 20 的同一条理由）。
  if (state.kind === "dev-build") {
    return {
      label: t("device.upgrade.action.default"),
      disabled: true,
      secondary: true,
    };
  }
  // 已是最新：入口保留为禁用态并注明版本，不隐藏（决策 20）。
  if (state.kind === "current") {
    return {
      label: t("device.upgrade.action.upToDate", { version: state.version }),
      disabled: true,
      secondary: true,
    };
  }
  return {
    label: t("device.upgrade.action.default"),
    disabled: false,
    secondary: false,
  };
}

/** 升级中 / 成功 / 超时失败 / 其它拒绝各自的一句话反馈。 */
function UpgradeStatus({
  phase,
  deviceID,
}: {
  phase: UpgradePhase;
  deviceID: number;
}) {
  const { t } = useTranslation();
  if (phase.kind === "requesting") {
    // 这一段可以长达几分钟：受理判定在那台机器上把下载与校验都做完了才应答。说清
    // 楚它在做什么，比一个转着的图标更能让人不去点第二次。
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-primary-text">
          {t("device.upgrade.status.requestingTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("device.upgrade.status.requestingBody")}
        </span>
      </div>
    );
  }
  if (phase.kind === "upgrading") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-primary-text">
          {t("device.upgrade.status.upgradingTitle", {
            version: phase.targetVersion,
          })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("device.upgrade.status.upgradingBody")}
        </span>
      </div>
    );
  }
  if (phase.kind === "success") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-status-running-text">
          {t("device.upgrade.status.successTitle")}
        </span>
        <span
          data-testid={`device-upgrade-versions-${deviceID}`}
          className="font-mono text-xs text-muted-foreground"
        >
          {`${phase.fromVersion} → ${phase.toVersion}`}
        </span>
      </div>
    );
  }
  if (phase.kind === "timeout") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-destructive-text">
          {t("device.upgrade.status.timeoutTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("device.upgrade.status.timeoutBody")}
        </span>
      </div>
    );
  }
  if (phase.kind === "active-turns") {
    // daemon 那句话原样呈现：界面、命令行与桌面端对同一件事只说一句话（决策 22）。
    return (
      <span
        data-testid={`device-upgrade-refusal-${deviceID}`}
        className="text-xs text-status-waiting"
      >
        {phase.message}
      </span>
    );
  }
  if (phase.kind === "failed" && phase.message) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-destructive-text">
          {t("device.upgrade.status.failedTitle")}
        </span>
        <span className="text-xs text-muted-foreground">{phase.message}</span>
      </div>
    );
  }
  return null;
}

/** 这一态的标题与那一行事实；「拿不到最新版信息」两句都不说（决策 19）。 */
function UpgradeHeadline({ state }: { state: AgentredVersionState }) {
  const { t } = useTranslation();
  if (state.kind === "protocol-mismatch") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-destructive-text">
          {t("device.upgrade.blockedTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("device.upgrade.blockedBody")}
        </span>
      </div>
    );
  }
  if (state.kind === "dev-build") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-foreground">
          {t("device.upgrade.devBuildTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("device.upgrade.devBuildBody")}
        </span>
      </div>
    );
  }
  if (state.kind === "upgradable") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-foreground">
          {t("device.upgrade.availableTitle", { version: state.latest })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("device.upgrade.availableBody")}
        </span>
      </div>
    );
  }
  return null;
}

/**
 * 设备卡展开区里的升级出口：一键升级与可复制的命令**始终并列**在这一处，不按状态
 * 二选一（决策 18）—— 协议不匹配那一态下一键升级必然够不着（握手都没过），命令是
 * 唯一出口；始终并列则只有一套布局，用户也能自己选。
 */
export function DeviceUpgradePanel({
  device,
  state,
  onDevices,
}: {
  device: DeviceItem;
  state: AgentredVersionState;
  /** 轮询期间取到的新设备清单：交给页面，卡上的版本因此跟着变。 */
  onDevices?: (devices: DeviceItem[]) => void;
}) {
  const { t } = useTranslation();
  const upgrade = useDeviceUpgrade(device.id, device.version, onDevices);
  const { phase } = upgrade;
  const blocked = state.kind === "protocol-mismatch";
  const action = actionLabel(state, phase, t);

  return (
    <div
      data-testid={`device-upgrade-${device.id}`}
      className={cn(
        "flex flex-col gap-3 rounded-md border p-3",
        blocked ? "border-destructive/30 bg-destructive-soft" : "border-border",
      )}
    >
      <UpgradeHeadline state={state} />
      <UpgradeStatus phase={phase} deviceID={device.id} />
      {/* 一键升级够不着这台机器时不画按钮：画一个点了必然失败的按钮不是出口。 */}
      {!blocked && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant={action.secondary ? "outline" : "default"}
            disabled={action.disabled}
            data-testid={`device-upgrade-action-${device.id}`}
            onClick={
              phase.kind === "active-turns"
                ? upgrade.requestForce
                : upgrade.start
            }
          >
            {action.label}
          </Button>
        </div>
      )}
      <UpdateCommandCard deviceID={device.id} />

      {/* 二次确认（决策 8/21）：只有在这里点了「仍然升级」，force=true 才真的出现
          在请求里 —— 点主动作那一下只打开这个框。 */}
      <DialogShell
        open={phase.kind === "active-turns" && phase.confirmOpen}
        onOpenChange={(open) => {
          if (!open) upgrade.cancelForce();
        }}
        size="sm"
        danger
      >
        <DialogShellHeader
          title={t("device.upgrade.confirm.title", {
            count: phase.kind === "active-turns" ? phase.activeTurns : 0,
          })}
          danger
        />
        <DialogShellBody>
          <p className="text-aux leading-relaxed text-muted-foreground">
            {t("device.upgrade.confirm.body")}
          </p>
        </DialogShellBody>
        <DialogShellFooter>
          <Button variant="outline" onClick={upgrade.cancelForce}>
            {t("device.upgrade.confirm.cancel")}
          </Button>
          <Button
            variant="destructive"
            data-testid={`device-upgrade-confirm-${device.id}`}
            onClick={upgrade.confirmForce}
          >
            {t("device.upgrade.confirm.confirm")}
          </Button>
        </DialogShellFooter>
      </DialogShell>
    </div>
  );
}
