import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

/**
 * R10 决策面板：会话停在等待用户输入时，给出与桌面端同一套选择。
 *   - 工具调用审批：Allow / Always allow / Deny（附理由）。
 *   - 提问回答：单选 / 多选 / 自定义答案，Submit / Skip。
 *
 * 「同一个待决策只能被回答一次」：handledRequestId 命中某张卡时，就地说明它已
 * 被处理（可能被本端刚答过，也可能被别的端先答了）并刷新状态，而不是报错或静默
 * 失败。提交后由上层重查 pendingWaiters —— 已消失的 waiter 不再渲染。
 *
 * waiter 形状来自 runtime.session.pendingWaiters（agentruntime 无 JSON tag，
 * 顶层是 PascalCase：RequestID / ToolName / Input / Questions）。
 */

export interface PendingToolPermissionShape {
  RequestID?: string;
  ToolName?: string;
  Input?: unknown;
}

export interface PendingAskQuestionShape {
  RequestID?: string;
  Questions?: AskQuestionShape[];
}

export interface AskQuestionShape {
  ID?: string;
  Question?: string;
  Header?: string;
  MultiSelect?: boolean;
  IsOther?: boolean;
  Options?: { Label?: string; Description?: string }[];
}

export interface AskAnswerSubmit {
  QuestionIndex: number;
  Labels: string[];
  OtherText: string;
}

interface DecisionPanelProps {
  toolPermissions: PendingToolPermissionShape[];
  askUserQuestions: PendingAskQuestionShape[];
  /** 已被处理的 requestId（本端提交后 gone，或别的端先答了）。 */
  handledRequestId?: string | null;
  onApproveTool: (
    requestId: string,
    opts: { allow: boolean; alwaysAllow: boolean; denyReason?: string },
  ) => void;
  onAnswerQuestion: (
    requestId: string,
    answers: AskAnswerSubmit[],
    skipped: boolean,
  ) => void;
}

export default function DecisionPanel({
  toolPermissions,
  askUserQuestions,
  handledRequestId,
  onApproveTool,
  onAnswerQuestion,
}: DecisionPanelProps) {
  const { t } = useTranslation();

  if (
    toolPermissions.length === 0 &&
    askUserQuestions.length === 0 &&
    !handledRequestId
  )
    return null;

  return (
    <div className="space-y-3" aria-label={t("session.decision.none")}>
      {handledRequestId && (
        <p
          role="status"
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
        >
          {t("session.decision.alreadyHandled")}
        </p>
      )}
      {toolPermissions.map((tp) => (
        <ToolPermissionCard
          key={tp.RequestID ?? "tp"}
          waiter={tp}
          handled={handledRequestId === tp.RequestID}
          onApprove={onApproveTool}
          t={t}
        />
      ))}
      {askUserQuestions.map((aq) => (
        <AskCard
          key={aq.RequestID ?? "aq"}
          waiter={aq}
          handled={handledRequestId === aq.RequestID}
          onAnswer={onAnswerQuestion}
          t={t}
        />
      ))}
    </div>
  );
}

function ToolPermissionCard({
  waiter,
  handled,
  onApprove,
  t,
}: {
  waiter: PendingToolPermissionShape;
  handled: boolean;
  onApprove: DecisionPanelProps["onApproveTool"];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const requestId = waiter.RequestID ?? "";
  const toolName = waiter.ToolName ?? t("session.transcript.tool");

  if (handled) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
        {t("session.decision.alreadyHandled")}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="text-sm font-semibold text-foreground">
        {t("session.decision.approveTool", { tool: toolName })}
      </p>
      {waiter.Input !== undefined && (
        <pre className="mt-1.5 overflow-x-auto rounded-md bg-code-surface px-2 py-1.5 text-xs text-code-foreground whitespace-pre-wrap break-words">
          {JSON.stringify(waiter.Input, null, 2)}
        </pre>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() =>
            onApprove(requestId, { allow: true, alwaysAllow: false })
          }
        >
          {t("session.decision.allow")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onApprove(requestId, { allow: true, alwaysAllow: true })
          }
        >
          {t("session.decision.alwaysAllow")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() =>
            onApprove(requestId, { allow: false, alwaysAllow: false })
          }
        >
          {t("session.decision.deny")}
        </Button>
      </div>
    </div>
  );
}

function AskCard({
  waiter,
  handled,
  onAnswer,
  t,
}: {
  waiter: PendingAskQuestionShape;
  handled: boolean;
  onAnswer: DecisionPanelProps["onAnswerQuestion"];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const requestId = waiter.RequestID ?? "";
  const questions = waiter.Questions ?? [];
  // 每题的选中项（单选 1 个 / 多选多个），用「自定义答案」文本框兜底。
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [others, setOthers] = useState<Record<number, string>>({});

  if (handled) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
        {t("session.decision.alreadyHandled")}
      </div>
    );
  }

  function toggle(qi: number, label: string, multi: boolean) {
    setSelected((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) {
        return {
          ...prev,
          [qi]: cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label],
        };
      }
      return { ...prev, [qi]: [label] };
    });
  }

  function submit(skipped: boolean) {
    const answers = questions
      .map((q, qi) => {
        const labels = selected[qi] ?? [];
        const otherText = others[qi] ?? "";
        return {
          QuestionIndex: qi,
          Labels: labels,
          OtherText: otherText,
        };
      })
      .filter((a) => !skipped && (a.Labels.length > 0 || a.OtherText));
    onAnswer(requestId, skipped ? [] : answers, skipped);
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="text-sm font-semibold text-foreground">
        {t("session.decision.askQuestion")}
      </p>
      <div className="mt-2 space-y-3">
        {questions.map((q, qi) => (
          <div key={q.ID ?? qi}>
            <p className="text-sm text-foreground">{q.Question ?? q.Header}</p>
            <div className="mt-1.5 space-y-1">
              {(q.Options ?? []).map((opt) => {
                const label = opt.Label ?? "";
                const checked = (selected[qi] ?? []).includes(label);
                return (
                  <label
                    key={label}
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <input
                      type={q.MultiSelect ? "checkbox" : "radio"}
                      name={`q-${requestId}-${qi}`}
                      checked={checked}
                      onChange={() => toggle(qi, label, !!q.MultiSelect)}
                    />
                    <span>
                      {label}
                      {opt.Description && (
                        <span className="block text-xs text-subtle-foreground">
                          {opt.Description}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
              {q.IsOther && (
                <input
                  className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  placeholder={t("session.decision.denyReason")}
                  value={others[qi] ?? ""}
                  onChange={(e) =>
                    setOthers((prev) => ({ ...prev, [qi]: e.target.value }))
                  }
                />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => submit(false)}>
          {t("session.decision.submit")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => submit(true)}>
          {t("session.decision.skip")}
        </Button>
      </div>
    </div>
  );
}
