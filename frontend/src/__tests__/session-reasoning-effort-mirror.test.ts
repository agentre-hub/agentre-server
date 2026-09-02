/**
 * 「把这条会话的思考力度也写到**发起端**那一台」（规格 2026-09-01「agentre-server
 * 宿主」）。
 *
 * 与写模型目标那一跳同形：向池子借一条到发起端**机器**的通道写一次，写完还回去。
 * 走 `machine:` 而不是 `conversation:` —— 服务端按对话解析出的是**承载**机器，
 * 正是这里要绕开的那一台。够不着时**抛出**，由调用方折进「只写成一台」。
 */
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeReasoningEffortToOrigin } from "@/components/session/sessionMirror";
import { withRelayClient } from "@/lib/relayClientPool";

vi.mock("@/lib/relayClientPool", () => ({ withRelayClient: vi.fn() }));

const mockWith = vi.mocked(withRelayClient);
const request = vi.fn();

beforeEach(() => {
  mockWith.mockReset();
  request.mockReset();
  request.mockResolvedValue({});
  mockWith.mockImplementation(
    async (_target: unknown, fn: (client: never) => unknown) =>
      fn({ request } as never) as never,
  );
});

describe("writeReasoningEffortToOrigin", () => {
  it("按机器寻址，并把 origin 一并带上让那一台解得出是哪条会话", async () => {
    await writeReasoningEffortToOrigin("fp-origin", {
      conversationId: "42",
      reasoningEffort: "high",
    });

    expect(mockWith.mock.calls[0][0]).toBe("machine:fp-origin");
    expect(request).toHaveBeenCalledWith(rpcMethods.setSessionReasoningEffort, {
      conversationId: "42",
      reasoningEffort: "high",
      peerFingerprint: "fp-origin",
    });
  });

  // 空串是**要写下去的值**（改回跟随后端配置），不是「不改」——不能在这里被当成
  // 空值省掉。
  it("空串照样写下去", async () => {
    await writeReasoningEffortToOrigin("fp-origin", {
      conversationId: "42",
      reasoningEffort: "",
    });

    expect(request.mock.calls[0][1]).toMatchObject({ reasoningEffort: "" });
  });

  it("够不着那一台时抛出，交给调用方折成「只写成一台」", async () => {
    mockWith.mockRejectedValue(new Error("origin offline"));

    await expect(
      writeReasoningEffortToOrigin("fp-origin", {
        conversationId: "42",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow("origin offline");
  });
});
