import { rpcMethods } from "@agentre-hub/agentre-wire";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSessionDecisionPorts } from "@/components/session/useSessionDecisionPorts";
import type { RelayClient } from "@/lib/relayClient";

import "@/i18n";

/**
 * 转录里的审批卡（`tool_approval`：org、ctl…）按下去，要打到那条会话所在机器的
 * `toolApproval.answer` 上（spec 2026-09-22 决策 13）：一条通用方法，按
 * conversation_id + request_id 指代那张卡。
 */
describe("useSessionDecisionPorts 的审批卡作答", () => {
  function setup(request: ReturnType<typeof vi.fn>) {
    const clientRef = { current: { request } as unknown as RelayClient };
    const originRef = { current: "fp-desktop" as string | undefined };
    return renderHook(() =>
      useSessionDecisionPorts({ sid: "conv-7", clientRef, originRef }),
    );
  }

  it("给定会话里一张待批的审批卡，当批准，则以会话 id、requestId 与 allow 调 toolApproval.answer", async () => {
    const request = vi.fn().mockResolvedValue({});
    const { result } = setup(request);

    await result.current.transcriptPorts.answerToolApproval({
      sessionId: 7,
      requestId: "ctl-1",
      allow: true,
    });

    const call = request.mock.calls.find(
      ([method]) => method === rpcMethods.toolApprovalAnswer,
    );
    expect(call?.[1]).toEqual({
      conversationId: "conv-7",
      requestId: "ctl-1",
      allow: true,
    });
  });

  it("给定那张卡已不再挂起，当作答，则中继的错误冒泡给卡片", async () => {
    const request = vi.fn(async (method: unknown) => {
      if (method === rpcMethods.toolApprovalAnswer) {
        throw new Error("no pending tool approval ctl-1");
      }
      return {};
    });
    const { result } = setup(request);

    await expect(
      result.current.transcriptPorts.answerToolApproval({
        sessionId: 7,
        requestId: "ctl-1",
        allow: false,
      }),
    ).rejects.toThrow("no pending tool approval");
  });
});
