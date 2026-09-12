import { compareVersions } from "@/lib/agentredVersion";

/**
 * 读懂 daemon 拒绝握手时那句话（agentre 的 `internal/pkg/wireversion` 的 `Reject`）。
 *
 * 那句话长这样，两个版本号都在里面：
 *
 * ```
 * peer speaks protocol version "0.3.0", this build accepts protocol versions 0.4.0 to 0.4.0
 * ```
 *
 * 「peer」是**这个页面**（浏览器出示自己的版本去握手），「this build」是**那台机器**上的
 * agentred——只有它会发这个码（wire 的 `ErrCodeProtocolVersion`），本站从不自己判版本，
 * 所以主语是固定的，不会反过来。
 *
 * 解析它而不是原样贴出来，是因为界面上要说的其实只有一句话：**该更新哪一头**。那句
 * 英文自己说得出这件事，但它是 Go 的 `fmt.Sprintf` 排版，不是给人读的句子。
 *
 * 句式的主人在 agentre 仓库。改了那边这里不会变红，所以认不出来时返回 null，横幅退回
 * 原样呈现——宁可给一句英文，也不编一个版本号出来。
 */
export type ProtocolRejection = {
  /** 两头里旧的那一头，也就是要动的那一头。 */
  stale: "page" | "machine";
  /** 这个页面出示的协议版本。 */
  page: string;
  /** 那台机器认的协议版本（旧构建的窗口是一个点，两端相同）。 */
  machine: string;
};

const REJECTION_RE =
  /peer speaks protocol version "?(\d+\.\d+\.\d+)"?, this build accepts protocol versions (\d+\.\d+\.\d+) to (\d+\.\d+\.\d+)/;

export function readProtocolRejection(
  detail: string | undefined,
): ProtocolRejection | null {
  if (!detail) return null;
  const m = REJECTION_RE.exec(detail);
  if (!m) return null;
  const [, page, min, max] = m;
  // 页面的版本落在机器窗口之下 / 之上，才说得出谁旧。落在窗口**之内**却仍被拒也是
  // 可能的（windowMatch 的第二个条件：页面自己的 min_supported 高过机器的 protocol），
  // 而那种情形下这两个数字之间看不出方向——不猜。
  if ((compareVersions(page, min) ?? 0) < 0) {
    return { stale: "page", page, machine: min };
  }
  if ((compareVersions(page, max) ?? 0) > 0) {
    return { stale: "machine", page, machine: max };
  }
  return null;
}
