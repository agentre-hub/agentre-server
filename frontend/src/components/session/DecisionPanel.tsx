import {
  CanonicalToolRouter,
  TranscriptPortsProvider,
  TranscriptUIStateProvider,
  type AnswerToolPermissionInput,
  type AnswerUserQuestionInput,
  type TranscriptPorts,
} from "@agentre-hub/agentre-ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { waiterBlocks } from "@/lib/waiterBlocks";

/**
 * R10 决策面板：会话停在等待用户输入时，把那些**转录自己画不出来**的待决摆出来。
 *
 * 卡片是共享包的 —— 与转录里那张**同一个组件**。此前这里是本站手画的第二份：
 * 工具授权是 `<pre>` 铺一坨 `JSON.stringify(Input)` 加三个按钮，提问是另一套单选
 * 多选。于是同一条待决，从事件流来（转录）是一个样子，从 `pendingWaiters` 来
 * （这里）是另一个样子——同一个审批在同一屏上有两种长相。
 *
 * **两份清单不合并**，这一点没变（见 `SessionDetailView` 的 `panelWaiters`）：
 * 卡来自事件流，浏览器手上有那一帧才画得出来；waiters 来自一次 RPC，说的是那台
 * 机器此刻真正阻塞在哪些请求上。镜像被裁剪、或浏览器从中途接进来时，只有后者
 * 兜得住。消掉的是画法，不是来源。
 *
 * 形态转换在 `lib/waiterBlocks.ts`（纯函数，单独测）：daemon 的 PascalCase
 * （agentruntime 结构体没有 JSON tag）搬成包的 camelCase DTO。
 *
 * ## 「按下去会发生什么」全部由宿主给
 *
 * 包的端口契约：渲染进包、动作由宿主注入。这里只要两个 —— 一条待决要么是工具
 * 授权、要么是提问，别的三个端口在这条路径上不可达，因此如实抛错而不是给一个
 * 静默的 no-op（与 `lib/transcriptPorts.ts` 同一条理由）。
 *
 * 宿主注入的那两个负责两件包不该知道的事：
 *   - **R10 预检**：这条待决已被别的端回答过时，`handledRequestId` 亮起来。
 *   - **决策 8**：提交失败走 toast + 重试，**不**在版面里长出一行红字，因此宿主
 *     那一侧吞掉异常、不再抛给卡片。
 *
 * 「已被处理」为什么是**面板级**而不是卡片自己的错误态：预检要刷一次 waiters，
 * 而「已被别的端答过」的直接后果就是**这条待决从清单里消失**——那张卡随之卸载。
 * 挂在卡上等于挂在一个正要消失的东西上，用户什么都看不到。这句话必须活得比卡长。
 */

// 形状的家在 lib/waiterBlocks.ts；这里再导出一次，是因为 `pages/Overview.tsx`
// 早就从本模块取它们了。搬家不该顺手改一个与本次改动无关的文件。
export type {
  AskQuestionShape,
  PendingAskQuestionShape,
  PendingToolPermissionShape,
} from "@/lib/waiterBlocks";

/**
 * 宿主要接的两个动作。形状就是包的端口形状 —— 这一层不做转换，`SessionDetailView`
 * 那边本来就要把它们映射成自己的 relay 请求。
 */
export interface DecisionPanelPorts {
  answerToolPermission(input: AnswerToolPermissionInput): Promise<void>;
  answerUserQuestion(input: AnswerUserQuestionInput): Promise<void>;
}

/** 这条路径上到不了的三个端口。抛错是为了「哪天真到了」当场暴露，而不是静默。 */
function unreachable(action: string): never {
  throw new Error(`Decision panel has no "${action}" waiter shape`);
}

export interface DecisionPanelProps {
  /** 提交时要带上的会话 id。包的卡片没有它就不提交。 */
  sessionId: number;
  toolPermissions: import("@/lib/waiterBlocks").PendingToolPermissionShape[];
  askUserQuestions: import("@/lib/waiterBlocks").PendingAskQuestionShape[];
  /** 刚刚发现已被别的端回答过的那一条（R10）。见文件头为什么它在这一级。 */
  handledRequestId?: string | null;
  ports: DecisionPanelPorts;
}

export default function DecisionPanel({
  sessionId,
  toolPermissions,
  askUserQuestions,
  handledRequestId,
  ports,
}: DecisionPanelProps) {
  const { t } = useTranslation();
  const blocks = useMemo(
    () => waiterBlocks({ toolPermissions, askUserQuestions }),
    [toolPermissions, askUserQuestions],
  );

  const transcriptPorts = useMemo<TranscriptPorts>(
    () => ({
      answerToolPermission: ports.answerToolPermission,
      answerUserQuestion: ports.answerUserQuestion,
      answerToolApproval: () => unreachable("answerToolApproval"),
      resolveExecApproval: () => unreachable("resolveExecApproval"),
      resolvePlanAction: () => unreachable("resolvePlanAction"),
    }),
    [ports],
  );

  if (blocks.length === 0 && !handledRequestId) return null;

  return (
    // 容器不带 aria-label：每张卡自己有标题，容器再冒充一个标签只会被读两遍。
    // 早先挂在这里的是「没有待处理的请求」，辅助技术会把一屏等着人批的审批卡
    // 念成那句话。
    <TranscriptPortsProvider ports={transcriptPorts}>
      <TranscriptUIStateProvider>
        <div className="space-y-3">
          {handledRequestId && (
            <p
              role="status"
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
            >
              {t("session.decision.alreadyHandled")}
            </p>
          )}
          {blocks.map(({ requestId, block }) => (
            <CanonicalToolRouter
              key={requestId}
              toolBlock={block}
              sessionId={sessionId}
              // 折叠态按 requestId 记：刷新一次 waiters 不该把用户刚展开的
              // 那张卡收回去。
              uiStateKey={`waiter:${requestId}`}
            />
          ))}
        </div>
      </TranscriptUIStateProvider>
    </TranscriptPortsProvider>
  );
}
