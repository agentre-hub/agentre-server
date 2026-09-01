import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Lock } from "lucide-react";

import {
  cn,
  type ChatComposerSubmit,
  type TranscriptMessage,
} from "@agentre-hub/agentre-ui";

import { computeContextUsage } from "@/lib/sessionView";

import type { SendFeedback } from "@/components/session/useSessionSend";
import { useAliveEffect } from "@/hooks/use-api-query";
import type { PermissionModeMeta } from "@/lib/backendCapabilities";
import type { SessionViewStatus } from "@/lib/sessionView";

/*
  输入框单独切一个 chunk。它背后是 TipTap（8 个 @tiptap/* 包），量下来给产物加了
  663 kB 原始 / **252 kB gzip** —— 而登录、总览、设备、组织这些页一次都用不到它。
  这份产物要 //go:embed 进 Go 二进制，每 KB 都进镜像。切出去之后入口回到
  455 kB gzip，那 251 kB 只在真的打开一条对话时才取。

  **不用 React.lazy + Suspense**，理由是硬的：Suspense 揭示内容走的是 Offscreen 的
  `reappearLayoutEffects` / `reconnectPassiveEffects` 路径，会把子树的 effect 重跑
  一遍，而共享包的 `AIChatInput` 在那条路径上拿到的是已经销毁的 editor —— 实测崩在
  「The editor view is not available」与「Cannot read properties of null (reading
  'commands')」，整棵 React 树被卸掉、页面白屏。StrictMode 下这条路径必走，所以
  `make dev` 一点开对话就是白屏。直接 import() 到 state 里再渲染就没有「揭示」这一步。

  代价是打开一条对话时输入框比其余部分晚一步出现，所以未到位时摆一个**等高**的
  占位条：不占位的话那一带会先塌下去再弹回来。
*/
type SessionComposerModule =
  typeof import("@/components/session/SessionComposer");

/**
 * 存的是**模块**而不是组件本身：组件从 hook 里出来会被
 * `react-hooks/static-components` 拦下（它看不出这个身份一旦加载就不再变），
 * 而 `<mod.default>` 是成员访问，规则不会误判。
 */
function useSessionComposerModule(): SessionComposerModule | null {
  const [mod, setMod] = useState<SessionComposerModule | null>(null);
  useAliveEffect((alive) => {
    void import("@/components/session/SessionComposer").then((m) => {
      if (alive()) setMod(m);
    });
  }, []);
  return mod;
}

export interface SessionComposerBandProps {
  did: number;
  sid: string;
  status: SessionViewStatus;
  /** 贴底与否决定这一带的上边界（规格 2026-08-23 决策 6）。 */
  atBottom: boolean;
  machineName: string | undefined;
  backendType: string | undefined;
  /** @ 菜单要提及的 Agent 清单（账号级）。 */
  agents: { name: string; avatar_color?: string }[];
  /** 上下文用量按它与窗口算；「这条会话启动过没有」也读它的条数。 */
  messages: TranscriptMessage[];
  contextWindow: number;
  sending: boolean;
  onSubmit: (text: string, images?: ChatComposerSubmit["images"]) => void;
  permissionMode: string;
  permissionModeMeta: PermissionModeMeta | null | undefined;
  permissionError: string | null;
  onPermissionModeChange: (value: string) => void;
  /** 模型控件由详情视图拼好交进来：改模型要写两台机器，那是它的事。 */
  modelControl: ReactNode;
  sendFeedback: SendFeedback;
}

/**
 * 钉住的那一带：输入框，或者三档「等下去也不会变」时的只读条。
 *
 * 「要不要换成只读条、只读条上写哪一句、上下文用量是多少」都归它 —— 除了这一带
 * 没有第二个读者。
 */
export default function SessionComposerBand({
  did,
  sid,
  status,
  atBottom,
  machineName,
  backendType,
  agents,
  messages,
  contextWindow,
  sending,
  onSubmit,
  permissionMode,
  permissionModeMeta,
  permissionError,
  onPermissionModeChange,
  modelControl,
  sendFeedback,
}: SessionComposerBandProps) {
  const { t } = useTranslation();
  const composerModule = useSessionComposerModule();

  /**
   * 输入框那一带换成**只读条**的三档（规格 2026-08-21 决策 4 / 5）。
   *
   * 判据是「等下去也不会变」：机器不在、App 没开、设备被撤销。摆一个永远灰着的
   * 输入框是在暗示「也许待会儿能用」，而这三档里前两档要等的是那台机器、第三档
   * 根本不会回来。
   *
   * `lost` 与 `pinnedAgentredUnavailable` **不**在其中：前者按一下「重新连接」就
   * 可能恢复，后者是这条会话暂时写不进去，输入框停用着就够了。
   *
   * 原因只在横幅里说一遍——此前这里还有一段 `composeUnavailable` 长文案，与横幅
   * 讲同一件事却换了套措辞，读者会当成两个问题（决策 5）。
   */
  const composeReadonly =
    status === "machineOffline" ||
    status === "desktopAppNotRunning" ||
    status === "deviceRevoked";

  /** 只读条上那一句短的：说「等谁」，不复述横幅里的后果。 */
  const readonlyNote =
    status === "deviceRevoked"
      ? t("session.compose.readonly")
      : machineName
        ? t("session.compose.waitingFor", { machine: machineName })
        : t("session.compose.waitingForUnknown");

  /**
   * @ 菜单里可提及的 Agent。共享包的提及模型按数字 `refId` 标识，而本站的 Agent
   * 身份是账号级同步标识（字符串），因此用清单里的**位置**当 refId —— 它只需要在
   * 这一次渲染里稳定且唯一，序列化出去的 `<agent id="N">名字</agent>` 靠 label
   * 表意（桌面端 chat_svc 也是这么读的）。
   */
  const mentionAgents = agents.map((a, i) => ({
    id: i + 1,
    name: a.name,
    avatarColor: a.avatar_color,
  }));

  /**
   * 上下文用量。窗口从中转事件流里的 context_window_updated / usage 归约而来
   * （reduceSessionState），用量取最后一条报得出 totalInputTokens 的助手消息。
   */
  const contextUsage = computeContextUsage(messages, contextWindow);

  /**
   * 钉住的一带只有 Composer。审批**不**在这里再来一条：对话流里已经有审批卡了
   * （interactiveRequestIds 已经把两处去重），底下再摆一条是同一件事说两遍。
   */
  /*
    这一带**始终在**（账号登出那一屏除外——它只剩重新登录）。此前它在
    `showTranscript` 为假时整个是 `null`：连接中根本没有输入框，连上的那一刻
    它凭空长出一块 ~86px 把版面顶开（决策 2）。
  */
  if (status === "loggedOut") return null;

  return (
    /* 边界跟随贴底（规格 2026-08-23 决策 6）：贴底时读作一整片，未贴底时一条
         分隔线加一段向上渐隐，把末行压掉一半说「下面还有」。常驻边框只办得到
         「锚住输入框」，办不到「说出内容被截断了」。 */
    <div
      data-testid="session-composer-band"
      data-scrolled={atBottom ? "false" : "true"}
      className={cn(
        "relative shrink-0 bg-card px-5 pt-2 pb-3",
        !atBottom && "border-t border-border",
      )}
    >
      {atBottom ? null : (
        <div
          data-testid="session-composer-band-fade"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-3.5 h-3.5 bg-gradient-to-t from-background to-transparent"
        />
      )}
      <div className="mx-auto w-full max-w-measure">
        {composeReadonly ? (
          <p
            data-testid="session-compose-readonly"
            className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong bg-secondary px-3 py-2.5 text-xs text-muted-foreground"
          >
            {status === "deviceRevoked" ? (
              <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            {readonlyNote}
          </p>
        ) : composerModule ? (
          <composerModule.default
            // 草稿属于**这一条**会话：换一条就该是空的。右栏是同实例换 props
            // （不整块重挂），所以由这个 key 把输入框自己重挂一次。
            key={`${did}:${sid}`}
            backendType={backendType}
            agents={mentionAgents}
            /*
                重连期间**不禁用**（决策 6）：重连通常几秒就回来，禁用换来的只是
                让人干等着。这时按发送会排一条看得见的队，连上自动发出。
              */
            disabled={
              sending || (status !== "connected" && status !== "reconnecting")
            }
            onSubmit={(text, images) => onSubmit(text, images)}
            contextUsage={contextUsage}
            permissionMode={permissionMode}
            permissionModeMeta={permissionModeMeta}
            permissionRuntimeKey={backendType}
            // 有消息就说明这条会话已经启动过：bypass 锁死判定的另一半。
            permissionHasActiveSession={messages.length > 0}
            permissionError={permissionError}
            onPermissionModeChange={onPermissionModeChange}
            modelControl={modelControl}
            feedback={
              // 失败不在这里了：它成了转录流里的一条气泡（决策 7）。这一格只剩
              // 「已排进这一轮」——那条消息**发出去了**，说的是另一件事。
              sendFeedback.kind === "queued" ? (
                <p
                  role="status"
                  className="border-t border-border px-3.5 py-1.5 text-xs text-muted-foreground"
                >
                  {t("session.sendQueued")}
                </p>
              ) : null
            }
          />
        ) : (
          <div
            aria-hidden="true"
            className="h-[86px] rounded-lg border border-border bg-secondary"
          />
        )}
      </div>
    </div>
  );
}
