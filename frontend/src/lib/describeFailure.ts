/**
 * 一次失败该怎么对用户说（规格 2026-11-05-ux-polish W5）。
 *
 * 给出三样东西：一句说得出事实的话（`message`，全由语言包拼成，不含原文）、一个出口
 * （`exit`：重试 / 去设备页 / 无）、一份原文（`diagnostic`，只进「复制诊断信息」）。
 *
 * 分类先认**结构化信号**：ApiError 的业务码与 HTTP 状态、RelayError 的 wire 码、派发
 * 那两个错误类（连不上 / 对端答了错）。只有浏览器自己的 fetch 失败没有任何码可认，
 * 才看一眼 message。认不出的一律 unknown：给重试，原文进诊断。不为分类改 `pkg/wire`。
 */
import {
  ErrCodeAccountServerUnreachable,
  ErrCodeInternal,
  ErrCodeMethodNotFound,
  ErrCodePairing,
  ErrCodeProtocolVersion,
  ErrCodeRemoteFSPermDenied,
  ErrCodeUnauthorized,
} from "@agentre-hub/agentre-wire";

import { ApiError } from "@/lib/api";
import { DispatchConnectionError } from "@/lib/dispatch";
import { FAILURE_CODES } from "@/lib/errorCodes";
import { readProtocolRejection } from "@/lib/protocolMismatch";
import { RelayError } from "@/lib/relayClient";

export type FailureCategory =
  "offline" | "peerRefused" | "versionTooOld" | "permission" | "unknown";

export type FailureExit = "retry" | "devices" | "none";

export interface Failure {
  category: FailureCategory;
  /** 给人读的那一句，当前语言，不含任何原文。 */
  message: string;
  exit: FailureExit;
  /** 原文（含错误类名、码、cause 链），只给「复制诊断信息」。 */
  diagnostic: string;
}

/**
 * 分类只知道**为什么**失败，只有调用方知道**什么**失败了——所以那半句由调用方带来，
 * 两半由语言包的模板拼成一句（中英文的接法不同，不在代码里拼标点）。这样新的调用方
 * 不必改这个文件：带上自己那半句就行。
 */
export interface FailureContext {
  /** 宿主的 `t`。message 只经它取文案。 */
  t: (key: string, options?: Record<string, unknown>) => string;
  /**
   * 失败的那件事本身，已翻译、不带原因与句末标点：「看板没取回来」「Study Mini 没能
   * 启动这个 Agent」。
   */
  what: string;
  /** 对端那台机器的名字。原因句里要点名它；不给就说「那台机器」。 */
  machine?: string;
}

/**
 * 原因句的键，每一句都接在调用方那半句后面。写全路径而不是拼：键名在源码里搜得到，
 * 语言包的「无人引用」守卫也认得出它们有读者。
 */
type Reason =
  | "common.failure.network"
  | "common.failure.unreachable"
  | "common.failure.refused"
  | "common.failure.machineOutdated"
  | "common.failure.pageOutdated"
  | "common.failure.versionMismatch"
  | "common.failure.signedOut"
  | "common.failure.denied"
  | "common.failure.unknown";

type Verdict = { category: FailureCategory; exit: FailureExit; reason: Reason };

const OFFLINE_NETWORK: Verdict = {
  category: "offline",
  exit: "retry",
  reason: "common.failure.network",
};
const OFFLINE_MACHINE: Verdict = {
  category: "offline",
  exit: "retry",
  reason: "common.failure.unreachable",
};
const SIGNED_OUT: Verdict = {
  category: "permission",
  exit: "none",
  reason: "common.failure.signedOut",
};
const DENIED: Verdict = {
  category: "permission",
  exit: "none",
  reason: "common.failure.denied",
};
const UNKNOWN: Verdict = {
  category: "unknown",
  exit: "retry",
  reason: "common.failure.unknown",
};

export function describeFailure(
  err: unknown,
  context: FailureContext,
): Failure {
  const verdict = classify(err);
  const { t } = context;
  const machine = context.machine || t("common.failure.thatMachine");
  return {
    category: verdict.category,
    exit: verdict.exit,
    message: t(verdict.reason, {
      what: context.what,
      machine,
    }),
    diagnostic: diagnose(err),
  };
}

function classify(err: unknown): Verdict {
  // 浏览器说自己离线时，任何一种失败读作断网都不会错。
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return OFFLINE_NETWORK;
  }
  // 派发把对端的错包了一层（DispatchRunError / DispatchConnectionError）：先找链上
  // 带码的那一个，码比包装类说得更准（连接阶段换票被拒是权限，不是离线）。
  const coded = findInChain(
    err,
    (e): e is ApiError | RelayError =>
      e instanceof ApiError || e instanceof RelayError,
  );
  if (coded instanceof ApiError) return classifyApi(coded);
  if (coded instanceof RelayError) return classifyRelay(coded);
  if (findInChain(err, (e) => e instanceof DispatchConnectionError)) {
    return OFFLINE_MACHINE;
  }
  // 唯一没有码可认的一类：fetch 自己失败时只抛一个 TypeError，各浏览器的原话不同
  // （Chromium「Failed to fetch」、Firefox「NetworkError …」、Safari「Load failed」）。
  // 认原话而不是认 TypeError 本身，免得把代码缺陷读成断网。
  const network = findInChain(
    err,
    (e) =>
      e instanceof TypeError &&
      /failed to fetch|networkerror|load failed|network request failed/i.test(
        e.message,
      ),
  );
  if (network) return OFFLINE_NETWORK;
  return UNKNOWN;
}

function classifyApi(err: ApiError): Verdict {
  if (err.status === 401 || err.code === FAILURE_CODES.Unauthorized) {
    return SIGNED_OUT;
  }
  if (err.status === 403 || err.code === FAILURE_CODES.Forbidden) return DENIED;
  if (
    err.code === FAILURE_CODES.RelayDaemonOffline ||
    err.code === FAILURE_CODES.RelayDaemonNotFound
  ) {
    return OFFLINE_MACHINE;
  }
  return UNKNOWN;
}

function classifyRelay(err: RelayError): Verdict {
  switch (err.code) {
    // -1 是 RelayClient 自己造的那一类（连接未就绪 / 已关闭 / 断线 / 超时）；
    // 账号服务够不着时对端明说「可重试」，对用户而言同样是这条路没走通。
    case -1:
    case ErrCodeAccountServerUnreachable:
      return OFFLINE_MACHINE;
    case ErrCodeProtocolVersion:
      return classifyProtocol(err.message);
    // 那台机器不认这个方法：它的 agentred 比这个页面旧。
    case ErrCodeMethodNotFound:
      return {
        category: "versionTooOld",
        exit: "devices",
        reason: "common.failure.machineOutdated",
      };
    case ErrCodeUnauthorized:
    case ErrCodePairing:
    case ErrCodeRemoteFSPermDenied:
      return DENIED;
    // 对端内部出错：不是它有意拒绝，原因说不清，重试可能就好了。
    case ErrCodeInternal:
      return UNKNOWN;
    default:
      // 其余 wire 码都是对端有意答「不」：原样再来一次不会换个答案。
      return {
        category: "peerRefused",
        exit: "none",
        reason: "common.failure.refused",
      };
  }
}

function classifyProtocol(detail: string): Verdict {
  const rejection = readProtocolRejection(detail);
  // 页面旧：要刷新的是这一页，设备页帮不上。
  if (rejection?.stale === "page") {
    return {
      category: "versionTooOld",
      exit: "none",
      reason: "common.failure.pageOutdated",
    };
  }
  if (rejection?.stale === "machine") {
    return {
      category: "versionTooOld",
      exit: "devices",
      reason: "common.failure.machineOutdated",
    };
  }
  // 句式认不出：说不准哪头旧，设备页上看得到两边的版本。
  return {
    category: "versionTooOld",
    exit: "devices",
    reason: "common.failure.versionMismatch",
  };
}

/** 沿 `cause` 链找第一个满足条件的错误。链可能成环，访问过的不再走。 */
function findInChain<T>(
  err: unknown,
  match: (e: unknown) => e is T,
): T | undefined;
function findInChain(err: unknown, match: (e: unknown) => boolean): unknown;
function findInChain(err: unknown, match: (e: unknown) => boolean): unknown {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    if (match(cur)) return cur;
    seen.add(cur);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return undefined;
}

/** 原文：每一层一行，带类名与码，排障时看得出是哪一层说的。 */
function diagnose(err: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let first = true;
  while (!seen.has(cur)) {
    seen.add(cur);
    lines.push((first ? "" : "caused by: ") + describeOne(cur));
    first = false;
    if (!(cur instanceof Error) || cur.cause === undefined) break;
    cur = cur.cause;
  }
  return lines.join("\n");
}

function describeOne(e: unknown): string {
  if (e instanceof ApiError) {
    return `ApiError [code=${e.code} status=${e.status}]: ${e.message}`;
  }
  if (e instanceof RelayError)
    return `${e.name} [code=${e.code}]: ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  if (e === undefined) return "undefined";
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}
