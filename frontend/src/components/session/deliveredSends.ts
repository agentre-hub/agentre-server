import type { TranscriptMessage } from "@agentre-hub/agentre-ui";

import type { FailedSend } from "@/components/session/SendFailureBubble";

/**
 * 哪几条「可能已送达」的气泡已经在转录里看得见了，可以收起（规格 2026-11-25 K4）。
 *
 * 判据只有一条，而且只朝「不收」那一侧放宽：同一对话的转录里有一条**用户**消息，
 * 文字相同、图片数相同、时间不早于这条消息交出的那一刻。任何一样对不上——文字改过、
 * 图数不同、时间未知（0）、旧记录没记交出时刻——都留着，不猜。
 *
 * 只看 `transport` 那一类：没送出（notSent / imageWhileRunning）与被拒（rejected）
 * 的确实没到对端，转录里出现同一句话只能是另一次发送，收掉它等于替用户丢一条消息。
 *
 * 同一句话可以合法地发两次：每条转录消息最多认领一个气泡。最早交出的气泡先认，认的是
 * 它够得着的最早那一条——晚交出的那个够得着的只会更少，这样分谁都不抢谁的。
 */
export function deliveredFailureIds(
  failures: readonly FailedSend[],
  transcript: readonly TranscriptMessage[],
): string[] {
  const waiting = failures
    .filter(
      (f): f is FailedSend & { handedOffAt: number } =>
        f.kind === "transport" && !!f.handedOffAt && f.handedOffAt > 0,
    )
    .sort((a, b) => a.handedOffAt - b.handedOffAt);
  if (waiting.length === 0) return [];
  const sent = transcript
    .filter((m) => m.role === "user" && m.createtime > 0)
    .map((m) => ({
      at: m.createtime,
      text: m.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(""),
      images: m.blocks.filter((b) => b.type === "image").length,
    }))
    .sort((a, b) => a.at - b.at);
  const claimed = new Set<number>();
  const delivered: string[] = [];
  for (const failure of waiting) {
    const images = failure.images?.length ?? 0;
    const at = sent.findIndex(
      (m, i) =>
        !claimed.has(i) &&
        m.at >= failure.handedOffAt &&
        m.text === failure.text &&
        m.images === images,
    );
    if (at < 0) continue;
    claimed.add(at);
    delivered.push(failure.id);
  }
  return delivered;
}
