import { useEffect, useId, useState, type FormEvent } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Copy,
  Download,
  X,
} from "lucide-react";

import { copyTextToClipboard, Button, cn } from "@agentre-hub/agentre-ui";

import CodeInput from "@/components/CodeInput";
import { Card } from "@/components/ui/card";
import { normalize, toChars } from "@/lib/userCode";

/** 能被「加进来」的设备类型。浏览器不是可管理设备；移动端没有可装的客户端。 */
type AddKind = "agentred" | "desktop";
type TargetOS = "linux" | "macos" | "windows";

const RELEASES_URL = "https://github.com/agentre-hub/agentre/releases/latest";

/** 与桌面端引导给的是同一条命令；改这里之前先确认那边也改了。 */
const INSTALL_UNIX = `curl -fsSL ${RELEASES_URL}/download/install.sh | sh`;
const INSTALL_WINDOWS = `irm ${RELEASES_URL}/download/install.ps1 | iex`;
const SERVICE_INSTALL = "agentred service install --start";

/**
 * 顺序是被 agentred 的落盘时序钉死的，不是排版偏好。
 *
 * `agentred login` 会一直阻塞轮询，直到用户批准才退出、并把这次认领写进
 * `state.json`；而 daemon 一旦跑起来就会把 `state.json` 读进内存并持有它
 * （`cmd/agentred/login.go` 的 `requireNoRunningDaemon` 因此在 daemon 运行时
 * 直接拒绝登录）。于是：
 *
 *   1. 登录必须排在 `agentred service install --start` 之前 —— 否则闸门当场
 *      拒绝，而 macOS 的 LaunchAgent 是 KeepAlive=true，pkill 也停不下来；
 *   2. **批准也必须排在它之前** —— 闸门拦不住「先 login 再起服务」这条：login
 *      过闸时 daemon 还没起来。daemon 抢在 login 退出前起来，就会拿着旧的
 *      （未登录的）state，它之后任何一次写盘都把刚落定的登录覆盖掉，症状是
 *      设备看着授权成功却永远连不上。
 *
 * 所以三步是：装 + 登录 → 输码批准 → 注册后台服务。二进制安装命令留在第 1 步：
 * 没有二进制就没有 `agentred login` 可运行，它是这一步的前置。
 */
const STEP_KEYS = ["login", "code", "service"] as const;

/**
 * 登录命令里的服务器地址 = **这个控制台自己的地址**。
 *
 * 写死域名（哪怕是 mockup 里的占位域名）会让自建部署的用户照抄一条连不上的命令，
 * 而错误要等到那台机器上才暴露。控制台知道自己的地址，用户不该手抄。
 */
function consoleOrigin(): string {
  return window.location.origin;
}

/**
 * 一条可复制的命令。
 *
 * 复制走共享包的 `copyTextToClipboard`：它在 `navigator.clipboard` 不存在时
 * （http:// 的非安全上下文，控制台部署在局域网 IP 上就是这种）退回
 * `execCommand("copy")`，所以按钮不再需要按能力藏起来——装设备这页恰恰是最
 * 需要复制命令的地方。用不带 toast 的那一层：反馈由按钮自己翻成「已复制」。
 */
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
  // 记的是「复制走的是哪一条命令」而不是「复制过没有」：切换系统会把同一张卡
  // 换成另一条命令，只记一个布尔值的话，按钮就会对着一条从没进过剪贴板的命令
  // 说「已复制」。
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copied = copiedCommand === command;

  // 计时从点击那一刻起算，与卡片此刻显示哪条命令无关。
  useEffect(() => {
    if (copiedCommand === null) return;
    const timer = window.setTimeout(() => setCopiedCommand(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedCommand]);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {label}
        </span>
        <Button
          variant="ghost"
          size="xs"
          data-testid={copyTestId}
          onClick={() => {
            copyTextToClipboard(command)
              .then((ok) => {
                // 没复制成就保持原样：命令本身仍然可以选中手抄，不谎报「已复制」。
                if (ok) setCopiedCommand(command);
              })
              .catch(() => {
                // 同上——Clipboard API 存在却拒绝（文档失焦、权限被拒）时也一样。
              });
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("device.add.copied") : t("device.add.copy")}
        </Button>
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
      <span className="text-aux font-medium text-foreground">{label}</span>
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
      <span className="font-mono text-3xs font-medium text-muted-foreground">
        {t("device.add.stepOf", { n: step })}
      </span>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="text-aux leading-relaxed text-muted-foreground">
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
        <li key={tip} className="flex gap-2.5 text-aux text-muted-foreground">
          <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-3xs text-muted-foreground">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 leading-relaxed">{tip}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 「怎么加一台设备」的页内引导：装好并登录 → 输入设备码批准 → 让它常驻后台。
 *
 * 只在设备页由唯一的「添加设备」入口召唤（空态默认展开），不是常驻区块。
 * 传了 onClose 才渲染收起控件——空态没有别的东西可看，收起等于把页面清空。
 *
 * 完成标记只跟「用户点过那一步的下一步」走：从步骤条直接跳到第 3 步不会给
 * 前两步补上勾，否则那个勾就是我们替用户编的。
 */
export function AddDeviceGuide({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<AddKind>("agentred");
  const [os, setOS] = useState<TargetOS>("linux");
  const [done, setDone] = useState<Set<number>>(new Set());
  const [chars, setChars] = useState<string[]>(() => toChars(""));
  const [incomplete, setIncomplete] = useState(false);
  const codeErrorId = useId();

  function finishStep(n: number) {
    setDone((prev) => new Set(prev).add(n));
    // 最后一步没有「下一步」可去：只落一个勾，不要把 step 推到一个不存在的
    // 编号上（那会把整块正文渲染成空白）。
    if (n < STEP_KEYS.length) setStep(n + 1);
  }

  /**
   * 第 2 步只做本地归一化，然后把设备码交给既有的授权确认屏。
   *
   * 「这个代码存不存在 / 是不是已经用过」不在这里问：那一屏拿到 user_code
   * 就会自己查 pending，查不到时用同一套 device.entry.errors 就地标红且
   * 保留已填字符。在这里再查一遍等于把那一屏的错误呈现复制第二份，
   * 而两份安全界面必然漂移（规格「不新增第二份批准界面」）。
   */
  function submitCode(e: FormEvent) {
    e.preventDefault();
    const norm = normalize(chars.join(""));
    // 不足六位（码格本身已挡下字母表外的字符）：一个请求都不发，停在原地。
    if (!norm) {
      setIncomplete(true);
      return;
    }
    nav(`/device?user_code=${encodeURIComponent(norm)}`);
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
                      "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-3xs",
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
                    <span className="truncate text-aux font-medium text-foreground">
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
                  ? "device.add.login.agentredTitle"
                  : "device.add.login.desktopTitle",
              )}
              description={t(
                isAgentred
                  ? "device.add.login.agentredDesc"
                  : "device.add.login.desktopDesc",
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
                  label={t("device.add.login.commandLabel")}
                  command={`agentred login --server ${server}`}
                  testId="add-device-command-login"
                  copyTestId="add-device-copy-login"
                />
                <TipList
                  tips={[
                    t("device.add.login.agentredTip1"),
                    t("device.add.login.agentredTip2"),
                    t("device.add.login.agentredTip3"),
                    t("device.add.login.agentredTip4"),
                  ]}
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
                    {t("device.add.login.next")}
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
                    <span className="min-w-0 flex-1 text-aux leading-relaxed text-muted-foreground">
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
                <CommandCard
                  label={t("device.add.login.serverLabel")}
                  command={server}
                  testId="add-device-server-address"
                  copyTestId="add-device-copy-server"
                />
                <TipList
                  tips={[
                    t("device.add.login.desktopTip1"),
                    t("device.add.login.desktopTip2"),
                    t("device.add.login.desktopTip3"),
                  ]}
                />
                <div className="flex justify-end border-t border-border pt-4">
                  <Button onClick={() => finishStep(1)}>
                    {t("device.add.login.next")}
                    <ArrowRight />
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {step === 2 && (
          <form onSubmit={submitCode} className="flex flex-col gap-4">
            <StepHead
              step={2}
              // 文案沿用既有输码屏：同一件事换个说法只会让人以为是两件事。
              title={t("device.entry.title")}
              description={t("device.entry.description")}
            />
            <div className="flex flex-col gap-3">
              <CodeInput
                value={chars}
                onChange={(next) => {
                  setChars(next);
                  // 用户一动手就撤掉红态，别让他继续瞪着上一次的错误。
                  setIncomplete(false);
                }}
                invalid={incomplete}
                describedBy={incomplete ? codeErrorId : undefined}
              />
              {incomplete && (
                <p
                  id={codeErrorId}
                  className="flex items-start gap-2 text-aux text-destructive"
                >
                  <CircleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {t("device.entry.errors.incomplete")}
                </p>
              )}
            </div>
            <p className="text-aux leading-relaxed text-muted-foreground">
              {t("device.add.code.handoff")}
            </p>
            <div className="flex justify-end border-t border-border pt-4">
              <Button type="submit">
                {t("device.entry.submit")}
                <ArrowRight />
              </Button>
            </div>
          </form>
        )}

        {step === 3 && (
          <>
            <StepHead
              step={3}
              title={t(
                isAgentred
                  ? "device.add.service.agentredTitle"
                  : "device.add.service.desktopTitle",
              )}
              description={t(
                isAgentred
                  ? "device.add.service.agentredDesc"
                  : "device.add.service.desktopDesc",
              )}
            />
            {/* 桌面端自带 agentred，没有第二个服务要注册——这一步就只剩那句说明。 */}
            {isAgentred && (
              <>
                <CommandCard
                  label={t("device.add.service.commandLabel")}
                  command={SERVICE_INSTALL}
                  testId="add-device-command-service"
                  copyTestId="add-device-copy-service"
                />
                <TipList
                  tips={[
                    t("device.add.service.tip1"),
                    t("device.add.service.tip2"),
                  ]}
                />
              </>
            )}
            <div className="flex justify-end border-t border-border pt-4">
              <Button onClick={() => finishStep(3)}>
                {t("device.add.service.finish")}
                <Check />
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
