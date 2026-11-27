/**
 * 「可能已送达」的气泡何时可以收起（规格 2026-11-25 K4）：同一对话的转录里出现了与它
 * 内容一致（文字相同、图片数相同）且时间不早于交出时刻的用户消息。匹配不上就一直
 * 保留，不猜；每条转录消息最多认领一个气泡，最早交出的先认、认最早的那条。
 */
import { describe, expect, it } from "vitest";

import type { TranscriptMessage } from "@agentre-hub/agentre-ui";

import type { FailedSend } from "@/components/session/SendFailureBubble";
import { deliveredFailureIds } from "@/components/session/deliveredSends";

const T0 = 1_764_000_000_000;

function userMessage(
  text: string,
  createtime: number,
  images = 0,
  id = createtime,
): TranscriptMessage {
  return {
    id,
    sessionId: 1,
    role: "user",
    blocks: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...Array.from({ length: images }, () => ({
        type: "image" as const,
        image: {
          dataUrl: "data:image/png;base64,AQID",
          mediaType: "image/png",
        },
      })),
    ],
    model: "",
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalInputTokens: 0,
    durationMs: 0,
    errorText: "",
    seq: 0,
    createtime,
  };
}

const shot = {
  dataUrl: "data:image/png;base64,AQID",
  mediaType: "image/png",
  name: "shot.png",
};

function maybeDelivered(
  over: Partial<FailedSend> & { id: string; text: string },
): FailedSend {
  return { kind: "transport", handedOffAt: T0, ...over };
}

describe("deliveredFailureIds", () => {
  it("文字相同、图片数相同、时间不早于交出时刻：收起", () => {
    const ids = deliveredFailureIds(
      [maybeDelivered({ id: "a", text: "部署一下", images: [shot] })],
      [userMessage("部署一下", T0 + 50, 1)],
    );
    expect(ids).toEqual(["a"]);
  });

  it("恰好在交出那一刻也算（不早于）", () => {
    expect(
      deliveredFailureIds(
        [maybeDelivered({ id: "a", text: "部署一下" })],
        [userMessage("部署一下", T0)],
      ),
    ).toEqual(["a"]);
  });

  it("早于交出时刻的同文消息不算：那是以前说过的同一句话", () => {
    expect(
      deliveredFailureIds(
        [maybeDelivered({ id: "a", text: "继续" })],
        [userMessage("继续", T0 - 1)],
      ),
    ).toEqual([]);
  });

  it("文字不同（改过的）不算", () => {
    expect(
      deliveredFailureIds(
        [maybeDelivered({ id: "a", text: "部署一下" })],
        [userMessage("部署一下吧", T0 + 50)],
      ),
    ).toEqual([]);
  });

  it("图片数不同不算", () => {
    expect(
      deliveredFailureIds(
        [maybeDelivered({ id: "a", text: "看图", images: [shot, shot] })],
        [userMessage("看图", T0 + 50, 1)],
      ),
    ).toEqual([]);
  });

  it("助手消息不算", () => {
    const reply = { ...userMessage("部署一下", T0 + 50), role: "assistant" };
    expect(
      deliveredFailureIds(
        [maybeDelivered({ id: "a", text: "部署一下" })],
        [reply],
      ),
    ).toEqual([]);
  });

  it("时间未知（0）不猜", () => {
    expect(
      deliveredFailureIds(
        [maybeDelivered({ id: "a", text: "部署一下" })],
        [userMessage("部署一下", 0)],
      ),
    ).toEqual([]);
  });

  it("没记交出时刻的（旧记录）不猜", () => {
    expect(
      deliveredFailureIds(
        [{ id: "a", text: "部署一下", kind: "transport" }],
        [userMessage("部署一下", T0 + 50)],
      ),
    ).toEqual([]);
  });

  it("只收「可能已送达」：没送出 / 被拒的那几类确实没到，永远不收", () => {
    const transcript = [userMessage("部署一下", T0 + 50)];
    for (const kind of ["notSent", "rejected", "imageWhileRunning"] as const) {
      expect(
        deliveredFailureIds(
          [maybeDelivered({ id: "a", text: "部署一下", kind })],
          transcript,
        ),
      ).toEqual([]);
    }
  });

  it("同一句话发了两次而转录里只有一条：只收最早交出的那一个", () => {
    const ids = deliveredFailureIds(
      [
        maybeDelivered({ id: "later", text: "好", handedOffAt: T0 + 10 }),
        maybeDelivered({ id: "first", text: "好", handedOffAt: T0 }),
      ],
      [userMessage("好", T0 + 100)],
    );
    expect(ids).toEqual(["first"]);
  });

  it("两条都在转录里：各认一条，两个都收", () => {
    const ids = deliveredFailureIds(
      [
        maybeDelivered({ id: "first", text: "好", handedOffAt: T0 }),
        maybeDelivered({ id: "later", text: "好", handedOffAt: T0 + 10 }),
      ],
      [userMessage("好", T0 + 5, 0, 1), userMessage("好", T0 + 100, 0, 2)],
    );
    expect(ids.sort()).toEqual(["first", "later"]);
  });
});
