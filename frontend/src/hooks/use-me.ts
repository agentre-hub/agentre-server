import { useSyncExternalStore } from "react";

import {
  api,
  ApiError,
  hasCsrfToken,
  setCsrfToken,
  setUnauthorizedHandler,
} from "@/lib/api";
import {
  bindAccount,
  readLocalIdentity,
  wipeBusinessData,
  writeLocalIdentity,
} from "@/lib/localStore";
import { backoffDelay } from "@/lib/relayBackoff";

export interface Me {
  user_id: number;
  email: string;
  display_name: string;
  avatar_url: string;
  github_login: string;
  csrf_token: string;
}

/**
 * - `loading`     还不知道是谁：在读本地身份，或没有本地身份、第一次核对在飞
 * - `verifying`   用着本地身份，核对在飞
 * - `ready`       服务端确认过
 * - `unstable`    用着本地身份，核对失败（断网 / 超时 / 5xx / 门户页），退避重试中
 * - `unreachable` 没有本地身份，也取不到，退避重试中
 * - `signedOut`   401：本地已清空，该去登录页了
 */
export type MeStatus =
  "loading" | "verifying" | "ready" | "unstable" | "unreachable" | "signedOut";

export interface MeState {
  me: Me | null;
  status: MeStatus;
  /** 连着失败了几次；`unstable` / `unreachable` 时从 1 起。 */
  attempt: number;
  /** 此刻有一次核对在飞（「立即重试」据此禁用自己）。 */
  inFlight: boolean;
}

const INITIAL: MeState = {
  me: null,
  status: "loading",
  attempt: 0,
  inFlight: false,
};

/** 核对失败后的退让：1s 起、30s 封顶、半幅抖动（与中继重拨同一形状）。 */
const RETRY_BACKOFF = { baseMs: 1_000, capMs: 30_000 };

/*
  身份是这个标签页的状态，不是哪个组件的（规格 2026-11-25 决策 A4）：全局只取一次，
  外壳、授权屏、账户页共用同一份；换页重挂不再重取。

  `round` 是这一轮的编号：invalidateMe 换轮之后，上一轮在飞的回调一律作废。
*/
let state: MeState = INITIAL;
let round = 0;
let started = false;
let signingOut = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(patch: Partial<MeState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function clearRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") retryMe();
}

function start(): void {
  if (started) return;
  started = true;
  setUnauthorizedHandler(onUnauthorized);
  window.addEventListener("online", retryMe);
  document.addEventListener("visibilitychange", onVisibilityChange);
  void restore(round);
}

/**
 * 有本地身份就先用它进入，不等网络（决策 A3）；核对随后在后台跑。
 *
 * CSRF token 与 `me` 的先后是有意义的：`RequireAuth` 拿 `me` 当闸门，放行的那一次
 * 提交里整棵子树一起挂上来，子树里「一挂上就发写请求」的（账号通道的取票 POST）会
 * 跑在任何 effect 前面。所以 token 一律先于 `me` 发布——本地身份带着上次的 token，
 * 冷启动时 sessionStorage 里没有副本，就先用它；核对回来再换成服务端给的。
 *
 * 核对与读本地**同时**起跑：本地存储可能一直不应答（旧版 iOS，见 localStore 的打开
 * 超时），没有本地身份可等时不该为它多等那几秒（决策 A6）。两边谁先到都要对：
 *
 *  - 本地先到：照旧先用它进入，核对回来再替换；
 *  - 核对先成功：直接进入；本地随后到了、却是另一个账号——上一个账号的东西照样清掉；
 *  - 核对先失败：等本地落定再决定是「网络不稳定」还是「连不上服务器」，不然离线
 *    打开时会先闪一下整屏连不上。
 */
let localPending: Promise<void> | null = null;

async function restore(mine: number): Promise<void> {
  const read = readLocalIdentity<Me>();
  localPending = read.then(() => {});
  // 晚一拍再发：restore 由 useSyncExternalStore 的订阅（提交期）触发，同步 publish
  // 会让挂载的那一遍所有订阅者再渲染一次。
  void Promise.resolve().then(() => {
    if (mine === round) check(mine);
  });
  const local = await read;
  if (mine !== round) return;
  localPending = null;
  if (!local?.user_id || signingOut || state.status === "signedOut") return;
  if (state.status === "loading") {
    if (!hasCsrfToken()) setCsrfToken(local.csrf_token);
    bindAccount(local.user_id);
    publish({ me: local, status: "verifying" });
    return;
  }
  const current = state.me;
  if (
    state.status === "ready" &&
    current &&
    current.user_id !== local.user_id
  ) {
    await wipeBusinessData();
    if (mine !== round) return;
    setCsrfToken(current.csrf_token);
    bindAccount(current.user_id);
    void writeLocalIdentity(current);
  }
}

function check(mine: number): void {
  clearRetry();
  publish({ inFlight: true });
  api<Me>("/v1/auth/me").then(
    (got) => void accept(mine, got),
    (err: unknown) => void fail(mine, err),
  );
}

async function accept(mine: number, got: Me): Promise<void> {
  if (mine !== round) return;
  // 身份换成了另一个账号（别的标签页登出又登进来）：上一个账号的东西一样不留。
  if (state.me && state.me.user_id !== got.user_id) {
    await wipeBusinessData();
    if (mine !== round) return;
  }
  setCsrfToken(got.csrf_token);
  bindAccount(got.user_id);
  void writeLocalIdentity(got);
  publish({ me: got, status: "ready", attempt: 0, inFlight: false });
}

async function fail(mine: number, err: unknown): Promise<void> {
  if (mine !== round) return;
  // 只有 401 才算登出（决策 A3）；api() 那一层已经喊过 onUnauthorized，这里只是
  // 不把它当成网络问题去重试。
  if (err instanceof ApiError && err.status === 401) {
    void signOutLocally();
    return;
  }
  if (localPending) {
    await localPending;
    if (mine !== round) return;
  }
  const attempt = state.attempt + 1;
  publish({
    status: state.me ? "unstable" : "unreachable",
    attempt,
    inFlight: false,
  });
  retryTimer = setTimeout(
    () => check(mine),
    backoffDelay(attempt - 1, RETRY_BACKOFF),
  );
}

/**
 * 401：先把本地清干净，再交出 `signedOut` 让 RequireAuth 去登录页——反过来的话，
 * 跳转会打断还没提交的清空，下次打开就又画出上一个人的东西。
 */
async function signOutLocally(): Promise<void> {
  if (signingOut || state.status === "signedOut") return;
  signingOut = true;
  const mine = round;
  clearRetry();
  await wipeBusinessData();
  signingOut = false;
  if (mine !== round) return;
  publish({ me: null, status: "signedOut", attempt: 0, inFlight: false });
}

function onUnauthorized(): void {
  void signOutLocally();
}

/**
 * 主动登出（`@/lib/signOut`）：这一轮作废、重试停掉。之后晚到的核对结果一律丢掉——
 * 不然一次在飞的 /auth/me 在清空之后回来，会把身份与 CSRF 副本又写回本机（决策 A2）。
 * 不发布新状态：登出由整页跳转收尾，这里不抢在它前面把路由带去登录页。
 */
export function abandonMe(): void {
  round += 1;
  localPending = null;
  clearRetry();
}

/** 在失败重试的间隙里立即再核对一次（「立即重试」、联网、回到前台）。 */
export function retryMe(): void {
  if (!started || state.inFlight) return;
  if (state.status !== "unstable" && state.status !== "unreachable") return;
  check(round);
}

/**
 * 回到刚打开标签页的样子：丢掉内存里的身份、停掉重试与监听，下一个使用者重新走
 * 「读本地 → 核对」。不碰本地存储。与 `invalidateRosters(null)` 同一用途：
 * src/test/setup.ts 每条用例前调用一次。
 */
export function invalidateMe(): void {
  round += 1;
  signingOut = false;
  localPending = null;
  clearRetry();
  if (started) {
    started = false;
    setUnauthorizedHandler(null);
    window.removeEventListener("online", retryMe);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  state = INITIAL;
  for (const l of listeners) l();
  if (listeners.size > 0) start();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;

/** 当前登录的人与身份状态。整个标签页共用一次取数（决策 A4）。 */
export function useMe(): MeState & { retry: () => void } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snap, retry: retryMe };
}
