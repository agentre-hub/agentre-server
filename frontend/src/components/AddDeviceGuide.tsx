import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, Copy, Download, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** 能被「加进来」的设备类型。浏览器不用加（用户正开着的这个已经在列表里），移动端没有可装的客户端。 */
type AddKind = "agentred" | "desktop";
type TargetOS = "linux" | "macos" | "windows";

const RELEASES_URL = "https://github.com/agentre-ai/agentre/releases/latest";

/** 与桌面端引导给的是同一条命令；改这里之前先确认那边也改了。 */
const INSTALL_UNIX = `curl -fsSL ${RELEASES_URL}/download/install.sh | sh`;
const INSTALL_WINDOWS = `irm ${RELEASES_URL}/download/install.ps1 | iex`;
const SERVICE_INSTALL = "agentred service install --start";

const STEP_KEYS = ["install", "login", "code"] as const;

/**
 * 登录命令里的服务器地址 = **这个控制台自己的地址**。
 *
 * 写死域名（哪怕是 mockup 里的占位域名）会让自建部署的用户照抄一条连不上的命令，
 * 而错误要等到那台机器上才暴露。控制台知道自己的地址，用户不该手抄。
 */
function consoleOrigin(): string {
  return window.location.origin;
}

/** 一条可复制的命令。剪贴板不可用（非安全上下文）时不渲染复制按钮——没有能力就不给控件。 */
function CommandCard({
  label,
  command,
  testId,
  copyTestId,
}: {
  label: string;
  command: string;
  testId: string;
  copyTestId: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {label}
        </span>
        {clipboard && (
          <Button
            variant="ghost"
            size="xs"
            data-testid={copyTestId}
            onClick={() => {
              clipboard
                .writeText(command)
                .then(() => setCopied(true))
                .catch(() => {
                  // 复制被浏览器拒了就保持原样：命令本身仍然可以选中手抄，
                  // 不谎报「已复制」。
                });
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? t("device.add.copied") : t("device.add.copy")}
          </Button>
        )}
      </div>
      <pre
        data-testid={testId}
        className="overflow-x-auto bg-code-surface px-3 py-2.5 font-mono text-xs text-code-foreground"
      >
        {command}
      </pre>
    </div>
  );
}

/** 选项按钮（设备类型 / 系统）：当前选中态由 aria-pressed 表达，不靠颜色。 */
function ChoiceButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={selected ? "default" : "outline"}
      size="sm"
      aria-pressed={selected}
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function StepHead({
  step,
  title,
  description,
}: {
  step: number;
  title: string;
  description: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-medium text-subtle-foreground">
        {t("device.add.stepOf", { n: step })}
      </span>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

/** 步骤正文下面的说明清单（会打印什么、会不会自己开浏览器、过期怎么办）。 */
function TipList({ tips }: { tips: string[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {tips.map((tip, i) => (
        <li
          key={tip}
          className="flex gap-2.5 text-[13px] text-muted-foreground"
        >
          <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-subtle-foreground">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 leading-relaxed">{tip}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 「怎么加一台设备」的页内引导：装上 agentred → 让它登录账号 → 输入设备码。
 *
 * 只在设备页由唯一的「添加设备」入口召唤（空态默认展开），不是常驻区块。
 * 传了 onClose 才渲染收起控件——空态没有别的东西可看，收起等于把页面清空。
 *
 * 完成标记只跟「用户点过那一步的下一步」走：从步骤条直接跳到第 3 步不会给
 * 前两步补上勾，否则那个勾就是我们替用户编的。
 */
export function AddDeviceGuide({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<AddKind>("agentred");
  const [os, setOS] = useState<TargetOS>("linux");
  const [done, setDone] = useState<Set<number>>(new Set());

  function finishStep(n: number) {
    setDone((prev) => new Set(prev).add(n));
    setStep(n + 1);
  }

  const server = consoleOrigin();
  const isAgentred = kind === "agentred";

  const kindChoice = (
    <div className="flex flex-col gap-2">
      <FieldLabel
        label={t("device.add.kindLabel")}
        hint={t("device.add.kindHint")}
      />
      <div className="flex flex-wrap gap-2">
        <ChoiceButton
          selected={isAgentred}
          onSelect={() => setKind("agentred")}
        >
          {t("device.add.kindAgentred")}
        </ChoiceButton>
        <ChoiceButton
          selected={!isAgentred}
          onSelect={() => setKind("desktop")}
        >
          {t("device.add.kindDesktop")}
        </ChoiceButton>
      </div>
    </div>
  );

  return (
    <Card
      data-testid="add-device-guide"
      className="gap-0 overflow-hidden rounded-lg border-border bg-card py-0 shadow-none"
    >
      {/* 步骤条：三格都是按钮，可 Tab 可点，当前步骤对辅助技术可识别（aria-current） */}
      <div className="flex items-stretch border-b border-border">
        <ol className="grid min-w-0 flex-1 grid-cols-1 md:grid-cols-3">
          {STEP_KEYS.map((key, i) => {
            const n = i + 1;
            const isDone = done.has(n);
            const active = step === n;
            return (
              <li key={key} className="min-w-0">
                <button
                  type="button"
                  data-testid={`add-device-step-${n}`}
                  aria-current={active ? "step" : undefined}
                  onClick={() => setStep(n)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 border-b border-border px-3.5 py-3 text-left transition-colors outline-none last:border-b-0 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 md:border-r md:border-b-0 md:last:border-r-0",
                    active && "bg-primary-soft",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px]",
                      isDone
                        ? "bg-status-running-bg text-status-running"
                        : active
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {isDone ? <Check className="size-3" /> : n}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {t(`device.add.steps.${key}.title`)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {isDone
                        ? t(`device.add.steps.${key}.done`)
                        : t(`device.add.steps.${key}.hint`)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {onClose && (
          <div className="flex shrink-0 items-center border-l border-border px-2">
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="add-device-collapse"
              aria-label={t("device.add.collapse")}
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        )}
      </div>

      <div
        data-testid="add-device-step-body"
        className="flex flex-col gap-4 p-4 md:p-5"
      >
        {step === 1 && (
          <>
            <StepHead
              step={1}
              title={t(
                isAgentred
                  ? "device.add.install.agentredTitle"
                  : "device.add.install.desktopTitle",
              )}
              description={t(
                isAgentred
                  ? "device.add.install.agentredDesc"
                  : "device.add.install.desktopDesc",
              )}
            />
            {kindChoice}
            {isAgentred ? (
              <>
                <div className="flex flex-col gap-2">
                  <FieldLabel
                    label={t("device.add.install.osLabel")}
                    hint={t("device.add.install.osHint")}
                  />
                  <div className="flex flex-wrap gap-2">
                    <ChoiceButton
                      selected={os === "linux"}
                      onSelect={() => setOS("linux")}
                    >
                      {t("device.add.install.osLinux")}
                    </ChoiceButton>
                    <ChoiceButton
                      selected={os === "macos"}
                      onSelect={() => setOS("macos")}
                    >
                      {t("device.add.install.osMacos")}
                    </ChoiceButton>
                    <ChoiceButton
                      selected={os === "windows"}
                      onSelect={() => setOS("windows")}
                    >
                      {t("device.add.install.osWindows")}
                    </ChoiceButton>
                  </div>
                </div>
                <CommandCard
                  label={t(
                    os === "windows"
                      ? "device.add.install.powershellLabel"
                      : "device.add.terminalLabel",
                  )}
                  command={os === "windows" ? INSTALL_WINDOWS : INSTALL_UNIX}
                  testId="add-device-command-install"
                  copyTestId="add-device-copy-install"
                />
                <CommandCard
                  label={t("device.add.install.serviceLabel")}
                  command={SERVICE_INSTALL}
                  testId="add-device-command-service"
                  copyTestId="add-device-copy-service"
                />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <a
                    href={RELEASES_URL}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="add-device-manual-download"
                    className="text-xs font-medium text-primary-text hover:underline"
                  >
                    {t("device.add.install.manual")}
                  </a>
                  <Button onClick={() => finishStep(1)}>
                    {t("device.add.install.next")}
                    <ArrowRight />
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <FieldLabel label={t("device.add.install.downloadLabel")} />
                  <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2.5">
                    <Download
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
                      {t("device.add.install.downloadBody")}
                    </span>
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={RELEASES_URL}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="add-device-download"
                      >
                        {t("device.add.install.download")}
                        <ArrowRight />
                      </a>
                    </Button>
                  </div>
                </div>
                <div className="flex justify-end border-t border-border pt-4">
                  <Button onClick={() => finishStep(1)}>
                    {t("device.add.install.next")}
                    <ArrowRight />
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <StepHead
              step={2}
              title={t(
                isAgentred
                  ? "device.add.login.agentredTitle"
                  : "device.add.login.desktopTitle",
              )}
              description={t(
                isAgentred
                  ? "device.add.login.agentredDesc"
                  : "device.add.login.desktopDesc",
              )}
            />
            {isAgentred ? (
              <CommandCard
                label={t("device.add.terminalLabel")}
                command={`agentred login --server ${server}`}
                testId="add-device-command-login"
                copyTestId="add-device-copy-login"
              />
            ) : (
              <CommandCard
                label={t("device.add.login.serverLabel")}
                command={server}
                testId="add-device-server-address"
                copyTestId="add-device-copy-server"
              />
            )}
            <TipList
              tips={
                isAgentred
                  ? [
                      t("device.add.login.agentredTip1"),
                      t("device.add.login.agentredTip2"),
                      t("device.add.login.agentredTip3"),
                    ]
                  : [
                      t("device.add.login.desktopTip1"),
                      t("device.add.login.desktopTip2"),
                      t("device.add.login.desktopTip3"),
                    ]
              }
            />
            <div className="flex justify-end border-t border-border pt-4">
              <Button onClick={() => finishStep(2)}>
                {t("device.add.login.next")}
                <ArrowRight />
              </Button>
            </div>
          </>
        )}

        {/* 第 3 步（收下 6 位设备码 → 跳既有授权确认屏）由下一个任务填入。
            在它落地之前这里不放任何占位内容，更不复制一份批准界面。 */}
      </div>
    </Card>
  );
}
