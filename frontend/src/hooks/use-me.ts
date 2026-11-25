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
 */
async function restore(mine: number): Promise<void> {
  const local = await readLocalIdentity<Me>();
  if (mine !== round) return;
  if (local?.user_id) {
    if (!hasCsrfToken()) setCsrfToken(local.csrf_token);
    bindAccount(local.user_id);
    publish({ me: local, status: "verifying" });
  }
  check(mine);
}

function check(mine: number): void {
  clearRetry();
  publish({ inFlight: true });
  api<Me>("/v1/auth/me").then(
    (got) => void accept(mine, got),
    (err: unknown) => fail(mine, err),
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

function fail(mine: number, err: unknown): void {
  if (mine !== round) return;
  // 只有 401 才算登出（决策 A3）；api() 那一层已经喊过 onUnauthorized，这里只是
  // 不把它当成网络问题去重试。
  if (err instanceof ApiError && err.status === 401) {
    void signOutLocally();
    return;
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
