import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Laptop, ShieldCheck, Timer } from "lucide-react";
import type { TFunction } from "i18next";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useMe } from "@/hooks/use-me";
import { deviceKindLabel } from "@/lib/deviceKind";

/** `/v1/oauth/device/pending` 的返回。 */
export interface PendingInfo {
  device_kind: string;
  platform: string;
  version: string;
  capabilities: Record<string, boolean>;
  expires_in: number;
}

/**
 * 能力键在摘要里的显示名：收录表内的键用控制台里的标题，表外的键原样
 * 透出键名（决策 12）——既不隐藏（用户有权知道设备声明了什么），
 * 也不替它编一句说明。
 */
function capabilityLabel(name: string, t: TFunction): string {
  const title = t(`device.approve.capabilities.${name}.title`, {
    defaultValue: "",
  });
  return title || name;
}

/** 授权对象是谁：头像取自当前会话，取不到就整个不渲染，不编一个占位身份。 */
function AccountAvatar() {
  const { me } = useMe();
  if (!me) return null;
  if (me.avatar_url) {
    return (
      <img
        src={me.avatar_url}
        alt=""
        aria-hidden="true"
        className="size-6 shrink-0 rounded-full object-cover"
      />
    );
  }
  // 三个字段都可能是空串（GitHub 允许不设显示名），全空就不画这个圈——
  // 一个空心圆点不比没有更有信息量。
  const initial = (me.display_name || me.github_login || me.email || "")
    .trim()
    .slice(0, 1)
    .toUpperCase();
  if (!initial) return null;
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary-text"
    >
      {initial}
    </span>
  );
}

/**
 * 由 expires_in 起算的实时倒计时，返回剩余秒数。
 *
 * 记的是截止时刻而不是「每秒减一」：标签页被后台节流时定时器会漏拍，
 * 减一法会越走越慢，把一个已经过期的请求显示成还有好几分钟。
 * 归零只报一次——报完就停表，导航由调用方做。
 */
function useCountdown(seconds: number, onExpire: () => void): number {
  const [left, setLeft] = useState(seconds);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });

  useEffect(() => {
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(remaining);
      return remaining;
    };
    if (tick() === 0) {
      onExpireRef.current();
      return;
    }
    const id = setInterval(() => {
      if (tick() === 0) {
        clearInterval(id);
        onExpireRef.current();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [seconds]);

  return left;
}

export interface DeviceApprovalProps {
  /** 归一化后的设备码（带连字符），大号展示给用户比对。 */
  code: string;
  info: PendingInfo;
  submitting: boolean;
  error: string | null;
  onApprove: () => void;
  onDeny: () => void;
  onExpire: () => void;
}

/**
 * 设备授权确认（画板 10 / 12）。
 *
 * 是 /device 里的一块整页区域，不是对话框（决策 8）：内容量超出对话框的
 * 合理体量，而 role="dialog" 会让屏幕阅读器把整页当成模态。
 */
export default function DeviceApproval({
  code,
  info,
  submitting,
  error,
  onApprove,
  onDeny,
  onExpire,
}: DeviceApprovalProps) {
  const { t } = useTranslation();
  const left = useCountdown(info.expires_in, onExpire);

  const minutes = Math.floor(left / 60);
  const seconds = left % 60;
  const granted = Object.entries(info.capabilities ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);

  // 风险文案看的是 compute 能力而不是 device_kind（决策 7）：
  // 会跑编码 agent 的是能力，不是型号名。
  const risky = info.capabilities?.compute === true;

  const kindLabel = deviceKindLabel(info.device_kind, t);

  return (
    <div className="flex w-full max-w-[576px] flex-col gap-6 rounded-lg border border-border bg-card p-6 sm:p-10">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-[7px] text-primary-text">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          <span className="text-xs font-semibold tracking-[0.4px]">
            {t("device.eyebrow")}
          </span>
        </div>
        <h1 className="text-2xl font-semibold text-foreground">
          {t("device.approve.title")}
        </h1>
        <div className="flex items-start gap-2">
          <AccountAvatar />
          <p className="text-sm text-muted-foreground">
            {t(
              risky
                ? "device.approve.risk.compute"
                : "device.approve.risk.neutral",
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3.5 rounded-md border border-border bg-code-surface p-4">
        <span className="flex size-[42px] shrink-0 items-center justify-center rounded-sm border border-border bg-card">
          <Laptop className="size-5 text-primary-text" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[15px] font-semibold text-foreground">
            {kindLabel}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {`${info.platform} · ${info.version}`}
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2.5 rounded-md bg-primary-soft px-4 py-5 text-center">
        <p className="text-[13px] font-medium text-primary-text">
          {t("device.approve.verify")}
        </p>
        <p className="font-mono text-[28px] font-semibold tracking-[7px] text-primary-text sm:text-[34px]">
          {code}
        </p>
      </div>

      {/* 能力清单压成一行摘要（设计稿精简档 B）：标题并列，说明不再逐条
          展开——设备卡、风险一行句与摘要共同交代「谁 / 能干什么」。 */}
      <p className="text-[13px] leading-[1.5] text-muted-foreground">
        {t("device.approve.capabilitiesSummary", {
          list: granted.map((name) => capabilityLabel(name, t)).join(" · "),
        })}
      </p>

      <div className="flex items-center gap-[9px] rounded-md bg-status-waiting-bg px-3.5 py-[11px]">
        <Timer
          className="size-[15px] shrink-0 text-status-waiting"
          aria-hidden="true"
        />
        {/* 可见的一行逐秒刷新，所以对读屏隐藏；播报交给下面那条只按分钟
            变化的 live region，否则每秒都会被念一遍（无障碍与响应式）。 */}
        <p
          aria-hidden="true"
          className="text-[13px] font-medium text-status-waiting"
        >
          {minutes > 0
            ? t("device.approve.expiry", { minutes, seconds })
            : t("device.approve.expirySeconds", { seconds })}
        </p>
        <span className="sr-only" aria-live="polite">
          {minutes > 0
            ? t("device.approve.expiryAnnounce", { minutes })
            : t("device.approve.expiryAnnounceSoon")}
        </span>
      </div>

      {error && (
        <Alert
          variant="destructive"
          className="border-destructive bg-destructive-soft"
        >
          {error}
        </Alert>
      )}

      {/* DOM 顺序把主操作放在前面（读屏与 Tab 先到「允许授权」），
          桌面端再用 row-reverse 摆回画板 10 的「拒绝在左、允许在右」。 */}
      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <Button
          type="button"
          onClick={onApprove}
          disabled={submitting}
          className="h-auto w-full px-[18px] py-[13px] sm:flex-1"
        >
          {t("device.approve.allow")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onDeny}
          disabled={submitting}
          className="h-auto w-full border-border bg-card px-[18px] py-[13px] sm:w-[150px]"
        >
          {t("device.approve.deny")}
        </Button>
      </div>

      <p className="text-xs text-subtle-foreground">
        {t("device.approve.fineprint")}
      </p>
    </div>
  );
}
