/**
 * 「这台 agentred 跑的是哪一版，要不要劝它升级」这件事的全部判定
 * （规格 2026-09-03-client-upgrade-guidance「控制台呈现与 latest 来源」）。
 *
 * 呈现层只读这里的结论，不自己比版本号——一处比法，两处画法（宽屏与窄屏）。
 */

const RELEASE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/;

type ParsedVersion = {
  parts: [number, number, number];
  /** 预发布后缀（`0.6.0-beta.1` 的 `beta.1`）；空串表示正式发布。 */
  prerelease: string;
};

function parseVersion(v: string): ParsedVersion | null {
  const m = RELEASE_VERSION_RE.exec(v.trim());
  if (!m) return null;
  return {
    parts: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ?? "",
  };
}

/**
 * 比较两个发布版本号：a 旧于 b 返回负数，相等返回 0，新于返回正数。
 *
 * 任一侧不是可比较的发布版本号（`dev`、`nightly-…`、空串）时返回 null ——
 * 不可比就是不可比，硬排会把一台机器判成过期然后一直劝升。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  }
  if (pa.prerelease === pb.prerelease) return 0;
  // 预发布排在同号正式版之前：0.6.0-beta.1 旧于 0.6.0。
  if (pa.prerelease === "") return 1;
  if (pb.prerelease === "") return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/**
 * 一台 agentred 在版本这件事上的状态。
 *
 * 「拿不到最新版信息」与「已是最新」是**两个**状态，不是同一个的两种说法：拿不到
 * 就是拿不到，界面上不能借「没有徽标」冒充「已是最新」（决策 19）。
 */
export type AgentredVersionState =
  /** 还没读到版本（还没握过手，或者旧 daemon 不自报）：什么都不说。 */
  | { kind: "unknown" }
  /** 已是最新。 */
  | { kind: "current"; version: string }
  /** 拿不到最新版信息，或这个版本号根本不可比：显示版本，不下判断。 */
  | { kind: "latest-unknown"; version: string }
  /** 旧于最新版：弱徽标 + 升级出口。 */
  | { kind: "upgradable"; version: string; latest: string }
  /** 握手被判定协议版本不合：强提示，出口只有可复制的命令（决策 13/18）。 */
  | { kind: "protocol-mismatch"; version: string };

export type AgentredVersionInput = {
  /** devices.version —— 每次镜像握手成功后按新值刷新，所以它是实时的。 */
  version: string;
  /** 上一次握手是不是被 daemon 判定协议版本不合（ListDevicesItem.protocol_mismatch）。 */
  protocolMismatch: boolean;
  /** 服务端缓存的最新发布版本；空串 = 服务端也不知道（决策 12）。 */
  latest: string;
};

export function agentredVersionState(
  input: AgentredVersionInput,
): AgentredVersionState {
  // 强提示优先：这台机器已经用不了了，比「有没有新版本」更要紧，而且此时多半连
  // 版本号都没读到（握手都没过）。
  if (input.protocolMismatch) {
    return { kind: "protocol-mismatch", version: input.version };
  }
  if (!input.version) return { kind: "unknown" };
  if (!input.latest) return { kind: "latest-unknown", version: input.version };
  const order = compareVersions(input.version, input.latest);
  // 比不了就不比：本地构建自称的版本号、带日期的 nightly 都落在这里，它们既不
  // 「过期」也不「已是最新」。
  if (order === null) return { kind: "latest-unknown", version: input.version };
  return order < 0
    ? { kind: "upgradable", version: input.version, latest: input.latest }
    : { kind: "current", version: input.version };
}
