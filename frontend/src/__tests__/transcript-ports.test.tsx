import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Transcript from "@/components/session/Transcript";
import { reduceFrames, type TranscriptFrame } from "@agentre-hub/agentre-ui";
import { createServerTranscriptPorts } from "@/lib/transcriptPorts";

import "@/i18n";

/**
 * 转录里那些**能点**的卡，点下去要真的打到中继上。
 *
 * 这份用例是归约器换成包 DTO 的直接后果：在那之前本站一个 canonical 都不产，
 * 包里的交互卡从来渲染不出来，于是 `transcriptPorts.ts` 五个必需端口全是抛错的
 * 桩，注释还写着「这条链路上它们不可达」。换完之后前提就反了 —— 授权卡与提问卡
 * 会带着能点的按钮渲染出来，桩再留着就是给用户一个点下去必炸的按钮。
 *
 * 所以这里钉两件事：按钮真的存在，且点下去调到宿主注入的那个动作上。
 */

function frames(...events: Record<string, unknown>[]): TranscriptFrame[] {
  return events.map((event, i) => ({ sessionId: 1, event, seq: i + 1 }));
}

function renderWith(
  events: Record<string, unknown>[],
  deps: Parameters<typeof createServerTranscriptPorts>[0],
) {
  return render(
    <Transcript
      messages={reduceFrames(frames(...events), 1)}
      sessionId={1}
      ports={createServerTranscriptPorts(deps)}
    />,
  );
}

describe("转录里的交互卡接到中继上", () => {
  it("给定待决的工具授权，当点「允许一次」，则以该 requestId 提交 allow", () => {
    const submitToolPermission = vi.fn().mockResolvedValue(undefined);
    renderWith(
      [
        {
          kind: "tool_permission_request",
          requestId: "r9",
          toolName: "Bash",
          input: { command: "ls -la" },
        },
      ],
      { submitToolPermission, submitAnswer: vi.fn() },
    );

    fireEvent.click(screen.getByText("Allow Once"));

    expect(submitToolPermission).toHaveBeenCalledTimes(1);
    expect(submitToolPermission.mock.calls[0][0]).toMatchObject({
      requestId: "r9",
      allow: true,
    });
  });

  it("给定待决的工具授权，当点「拒绝」，则提交 allow=false", () => {
    const submitToolPermission = vi.fn().mockResolvedValue(undefined);
    renderWith(
      [
        {
          kind: "tool_permission_request",
          requestId: "r9",
          toolName: "Bash",
          input: { command: "rm -rf /tmp/x" },
        },
      ],
      { submitToolPermission, submitAnswer: vi.fn() },
    );

    fireEvent.click(screen.getByText("Reject"));

    expect(submitToolPermission.mock.calls[0][0]).toMatchObject({
      requestId: "r9",
      allow: false,
    });
  });

  it("给定已决议的授权，当渲染，则不再有可点的决策按钮", () => {
    // 决议由 tool_permission_resolved 回填到同一张卡上，卡切只读态。
    // 这正是用户此前看到「未知事件 · tool_permission_resolved」的那一条。
    renderWith(
      [
        {
          kind: "tool_permission_request",
          requestId: "r9",
          toolName: "Bash",
          input: { command: "ls -la" },
        },
        { kind: "tool_permission_resolved", requestId: "r9", allowed: true },
      ],
      { submitToolPermission: vi.fn(), submitAnswer: vi.fn() },
    );

    expect(screen.queryByText("Allow Once")).toBeNull();
    expect(screen.queryByText("Reject")).toBeNull();
  });

  it("给定待答的提问，当选一项并提交，则以该 requestId 提交答案", () => {
    const submitAnswer = vi.fn().mockResolvedValue(undefined);
    renderWith(
      [
        {
          kind: "ask_user_question",
          requestId: "q1",
          questions: [
            {
              question: "要不要顺手改 e2e？",
              options: [{ label: "要" }, { label: "不要" }],
            },
          ],
        },
      ],
      { submitToolPermission: vi.fn(), submitAnswer },
    );

    fireEvent.click(screen.getByText("要"));
    fireEvent.click(screen.getByText("Submit Reply"));

    expect(submitAnswer).toHaveBeenCalledTimes(1);
    expect(submitAnswer.mock.calls[0][0]).toMatchObject({ requestId: "q1" });
  });

  /**
   * 提交失败必须**冒泡**。包的端口契约明写「所有方法都可能失败，包内只负责把
   * reject 冒泡给卡片自己的错误态，不吞异常」—— 宿主这一层吞掉的话，按钮会显示
   * 成功，而那台机器上的工具还阻塞着。
   */
  it("给定提交失败，当点按钮，则错误不被宿主吞掉", async () => {
    const boom = new Error("socket closed");
    const submitToolPermission = vi.fn().mockRejectedValue(boom);
    const ports = createServerTranscriptPorts({
      submitToolPermission,
      submitAnswer: vi.fn(),
    });

    await expect(
      ports.answerToolPermission({
        sessionId: 1,
        requestId: "r9",
        allow: true,
      }),
    ).rejects.toThrow("socket closed");
  });

  /**
   * 中继上没有对应方法的那三个，如实抛错而不是 no-op。一个点了什么都不发生的
   * 按钮只有用户能发现；抛错当场暴露。
   */
  it.each([
    "answerToolApproval",
    "resolveExecApproval",
    "resolvePlanAction",
  ] as const)("%s 中继没有对应方法，如实抛错", (name) => {
    const ports = createServerTranscriptPorts({
      submitToolPermission: vi.fn(),
      submitAnswer: vi.fn(),
    });

    expect(() =>
      (ports[name] as (input: unknown) => unknown)({ sessionId: 1 }),
    ).toThrow(/no relay method/);
  });
});
