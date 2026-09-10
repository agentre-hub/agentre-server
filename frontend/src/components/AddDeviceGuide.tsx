import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Check, CircleAlert, Download } from "lucide-react";

import {
  AGENTRED_RELEASES_URL,
  AgentredInstallDocsLink,
  AgentredInstallSection,
  AgentredServiceSection,
  Button,
  CommandCard,
  GuideStepRail,
  agentredLoginCommand,
  type AgentredInstallMethod,
  type AgentredTargetOS,
  type GuideStep,
} from "@agentre-hub/agentre-ui";

import CodeInput from "@/components/CodeInput";
import { Card } from "@/components/ui/card";
import { normalize, toChars } from "@/lib/userCode";

/** 能被「加进来」的设备类型。浏览器不是可管理设备；移动端没有可装的客户端。 */
type AddKind = "agentred" | "desktop";

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

/** 选项按钮（设备类型）：当前选中态由 aria-pressed 表达，不靠颜色。 */
function ChoiceButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
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

/**
 * 「怎么加一台设备」的页内引导：装好并登录 → 输入设备码批准 → 让它常驻后台。
 *
 * 只在设备页由唯一的「添加设备」入口召唤（空态默认展开），不是常驻区块。
 * 传了 onClose 才渲染收起控件——空态没有别的东西可看，收起等于把页面清空。
 *
 * 安装与常驻两段、步骤条与命令卡都来自 `@agentre-hub/agentre-ui`：桌面端的接入
 * 引导渲染的是同一份，命令也只有那一份。控制台独有的部分——自己的 origin、
 * 设备码输入、跳授权确认屏、设备类型选择——留在这里。
 *
 * 完成标记只跟「用户点过那一步的下一步」走：从步骤条直接跳到第 3 步不会给
 * 前两步补上勾，否则那个勾就是我们替用户编的。
 */
export function AddDeviceGuide({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<AddKind>("agentred");
  const [method, setMethod] = useState<AgentredInstallMethod>("native");
  const [os, setOS] = useState<AgentredTargetOS>("linux");
  const [done, setDone] = useState<number[]>([]);
  const [chars, setChars] = useState<string[]>(() => toChars(""));
  const [incomplete, setIncomplete] = useState(false);
  const codeErrorId = useId();

  function finishStep(n: number) {
    setDone((prev) => (prev.includes(n) ? prev : [...prev, n]));
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

  const steps: readonly GuideStep[] = STEP_KEYS.map((key) => ({
    key,
    title: t(`device.add.steps.${key}.title`),
    hint: t(`device.add.steps.${key}.hint`),
    doneLabel: t(`device.add.steps.${key}.done`),
  }));

  const kindChoice = (
    <div className="flex flex-col gap-2">
      <span className="text-aux font-medium text-foreground">
        {t("device.add.kindLabel")}
      </span>
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
      <GuideStepRail
        steps={steps}
        current={step}
        done={done}
        onSelect={setStep}
        onDismiss={onClose}
      />

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
                <AgentredInstallSection
                  method={method}
                  onMethodChange={setMethod}
                  os={os}
                  onOsChange={setOS}
                  installTestId="add-device-command-install"
                  installCopyTestId="add-device-copy-install"
                />
                <CommandCard
                  label={t("device.add.login.commandLabel")}
                  command={agentredLoginCommand(method, server)}
                  testId="add-device-command-login"
                  copyTestId="add-device-copy-login"
                />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <AgentredInstallDocsLink
                    method={method}
                    testId="add-device-manual-download"
                  />
                  <Button onClick={() => finishStep(1)}>
                    {t("device.add.login.next")}
                    <ArrowRight />
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <span className="text-aux font-medium text-foreground">
                    {t("device.add.install.downloadLabel")}
                  </span>
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
                        href={AGENTRED_RELEASES_URL}
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
              // 不给 onRunModeChange：控制台的设备要长期在线，一个会随终端关闭
              // 而消失的「前台临时」对它没有意义。
              <AgentredServiceSection
                method={method}
                serviceTestId="add-device-command-service"
                serviceCopyTestId="add-device-copy-service"
              />
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
