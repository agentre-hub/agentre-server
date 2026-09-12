import { compareVersions } from "@/lib/agentredVersion";

/**
 * 读懂 daemon 拒绝握手时那句话（agentre 的 `internal/pkg/wireversion` 的 `Reject`）。
 *
 * 那句话长这样，两个版本号都在里面：
 *
 * ```
 * peer speaks wire protocol version "0.3.0", this build speaks "0.1.0"; both ends must run the same release
 * ```
 *
 * 「peer」是**这个页面**（浏览器出示自己的版本去握手），「this build」是**那台机器**上的
 * agentred——只有它会发这个码（wire 的 `ErrCodeProtocolVersion`），本站从不自己判版本，
 * 所以主语是固定的，不会反过来。
 *
 * 判据是**精确相等**：同一个 release 的两端带同一份生成 schema，跨 release 谁也读不出
 * 对方的约定，所以那句话里一边一个版本号，没有窗口可言。
 *
 * 解析它而不是原样贴出来，是因为界面上要说的其实只有一句话：**该更新哪一头**。那句
 * 英文自己说得出这件事，但它是 Go 的 `fmt.Sprintf` 排版，不是给人读的句子。
 *
 * 句式的主人在 agentre 仓库。改了那边这里不会变红，所以认不出来时返回 null，横幅退回
 * 原样呈现——宁可给一句英文，也不编一个版本号出来。那条静默退化的路已经被
 * `EXPECTED_REJECTION` 钉住一半：预期句式与这里的正则写在同一个文件里，由
 * `__tests__/protocol-mismatch.test.ts` 断言它解析得出结果，所以两者不可能悄悄错开。
 */
export type ProtocolRejection = {
  /** 两头里旧的那一头，也就是要动的那一头。 */
  stale: "page" | "machine";
  /** 这个页面出示的协议版本。 */
  page: string;
  /** 那台机器上那个构建讲的协议版本。 */
  machine: string;
};

const REJECTION_RE =
  /peer speaks wire protocol version "?(\d+\.\d+\.\d+)"?, this build speaks "?(\d+\.\d+\.\d+)"?/;

/**
 * 本次构建**预期**收到的那句话，逐字照 agentre 的 `wireversion.Reject` 抄下来，只把两个
 * 版本号换成一眼认得出的样本值（Go 侧两个都走 `%q`，所以真话里都带引号）。
 *
 * 它留在实现文件里而不是测试里，是为了让「预期句式」和读它的正则挨在一起：这个解析器
 * 失手的方式是返回 null，而 null 是一条合法路径（横幅退回原话），所以文案漂了没有任何
 * 东西会红。测试拿这一条断言解析结果不为 null，于是句式与正则只能一起改。
 *
 * 这钉不住对端真的说了什么——句式的主人在另一个仓库，本仓拿不到那份源码（拒绝只以一个
 * 错误码加一句自由文本到达）。它钉住的是本仓自己的一致性。
 */
export const EXPECTED_REJECTION = {
  detail:
    'peer speaks wire protocol version "1.2.3", this build speaks "4.5.6"; both ends must run the same release',
  page: "1.2.3",
  machine: "4.5.6",
} as const;

export function readProtocolRejection(
  detail: string | undefined,
): ProtocolRejection | null {
  if (!detail) return null;
  const m = REJECTION_RE.exec(detail);
  if (!m) return null;
  const [, page, machine] = m;
  const order = compareVersions(page, machine) ?? 0;
  // 两个数字相等的话这句话自相矛盾（相等就不会被拒），说不出谁旧——不猜。
  if (order < 0) return { stale: "page", page, machine };
  if (order > 0) return { stale: "machine", page, machine };
  return null;
}
