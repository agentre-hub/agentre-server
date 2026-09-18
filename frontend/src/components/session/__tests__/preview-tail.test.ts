/**
 * 预览尾巴：逐 token 呈现，且不把同一段正文渲染两遍。
 *
 * 协议 0.2.0 起同一段话到达两次：先是不带 seq 的**预览帧**（逐 token 增量），随后是
 * 块定稿后带 seq 的**持久帧**——而持久文本块投影出来的判别值同样是 `text_delta`、
 * 载荷是**整段**文本，共享包的归约器对它一律追加。两者都进转录就是
 * `"onetwoonetwothreefourfive"`（桌面端实测过的那一串）。
 *
 * 断言一律落在**归约出来的正文**上，不落在中间的缓冲数组上：缓冲对不对不重要，
 * 用户看见的那段字对不对才重要。
 */
import { reduceFrames } from "@agentre-hub/agentre-ui";
import {
  EventTextDelta,
  EventToolPermissionRequest,
} from "@agentre-hub/agentre-wire";
import { describe, expect, it } from "vitest";

import {
  TranscriptSessionId,
  toTranscriptFrame,
  type SessionEventFrame,
} from "@/components/session/transcriptFrame";
import { nextPreviewTail } from "@/components/session/previewTail";

const CID = "11111111-1111-7111-8111-111111111111";

function textFrame(text: string, seq?: number): SessionEventFrame {
  return toTranscriptFrame(
    { conversationId: CID, seq, event: { kind: EventTextDelta, text } },
    0,
  );
}

/** 一条工具审批请求：块级事件，不是逐 token 增量。 */
function permissionFrame(requestId: string, seq?: number): SessionEventFrame {
  return toTranscriptFrame(
    {
      conversationId: CID,
      seq,
      event: {
        kind: EventToolPermissionRequest,
        requestId,
        toolName: "Edit",
        input: { file_path: "/a.ts" },
      },
    },
    0,
  );
}

/** 归约出来的审批卡张数。 */
function permissionCardCount(
  durable: readonly SessionEventFrame[],
  tail: readonly SessionEventFrame[],
): number {
  return reduceFrames([...durable, ...tail], TranscriptSessionId)
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === "tool_permission_request").length;
}

/** 渲染出来的助手正文。 */
function renderedText(
  durable: readonly SessionEventFrame[],
  tail: readonly SessionEventFrame[],
): string {
  const messages = reduceFrames([...durable, ...tail], TranscriptSessionId);
  return messages
    .flatMap((message) =>
      message.blocks.filter((b) => b.type === "text").map((b) => b.text ?? ""),
    )
    .join("");
}

describe("preview tail", () => {
  it("streams per token, then hands the same text over to the durable frame without doubling it", () => {
    const durable: SessionEventFrame[] = [];
    let tail: SessionEventFrame[] = [];

    // 逐 token 到达：正文必须跟着长出来。
    tail = nextPreviewTail(tail, true, textFrame("one"));
    expect(renderedText(durable, tail)).toBe("one");
    tail = nextPreviewTail(tail, true, textFrame(" two"));
    expect(renderedText(durable, tail)).toBe("one two");

    // 块定稿：持久帧带来的是**整段**，缓冲必须在此刻清空。
    const block = textFrame("one two", 1);
    durable.push(block);
    tail = nextPreviewTail(tail, false);
    expect(renderedText(durable, tail)).toBe("one two");
  });

  it("keeps streaming the next block after the previous one settled", () => {
    const durable: SessionEventFrame[] = [textFrame("one two", 1)];
    let tail: SessionEventFrame[] = nextPreviewTail([], false);

    tail = nextPreviewTail(tail, true, textFrame(" three"));
    expect(renderedText(durable, tail)).toBe("one two three");

    const second = textFrame(" three four", 2);
    durable.push(second);
    tail = nextPreviewTail(tail, false);
    expect(renderedText(durable, tail)).toBe("one two three four");
  });

  /*
    块级事件的预览副本会落在**它自己的持久帧之后**（dev 环境抓包实测：
    seq=4 的 tool_permission_request 先到，1ms 后同一个 requestId 的预览副本再到），
    而轮次就此停在审批上 —— 再没有持久帧来清尾巴。于是那一帧永远留在投影里，
    共享包对 tool_permission_request 又是无条件 push 新块，屏幕上就长出第二张卡。
  */
  it("块级预览帧不进尾巴：它的持久帧早到了，追进去就是第二张审批卡", () => {
    const durable: SessionEventFrame[] = [permissionFrame("f3ed49e3", 4)];
    expect(permissionCardCount(durable, [])).toBe(1);

    const tail = nextPreviewTail([], true, permissionFrame("f3ed49e3"));

    expect(permissionCardCount(durable, tail)).toBe(1);
    expect(tail).toHaveLength(0);
  });

  // 补齐是成批的持久帧。缓冲里那点没定稿的正文此刻已经被它们覆盖，留着就是重复。
  it("drops the tail when catch-up delivers durable frames", () => {
    let tail: SessionEventFrame[] = nextPreviewTail(
      [],
      true,
      textFrame("partial"),
    );
    expect(tail).toHaveLength(1);

    tail = nextPreviewTail(tail, false);

    expect(tail).toHaveLength(0);
  });
});
