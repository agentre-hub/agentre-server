type ApiEnvelope<T> = { code: number; msg: string; data: T };

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
  if (t) sessionStorage.setItem("csrf", t);
  else sessionStorage.removeItem("csrf");
}
export function hasCsrfToken(): boolean {
  return csrfToken !== null;
}
export function loadCsrfToken() {
  csrfToken = sessionStorage.getItem("csrf");
}

/**
 * 任何请求回 401 时喊谁（规格 2026-11-25 决策 A2/A3：只有 401 才算登出）。由身份模块
 * 注册——它决定要不要清空本地、去登录页；这里只负责「看到了 401」，不认识登录页。
 */
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export class ApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * 服务端回的不是 JSON（502 的 HTML、门户页、网关错误页）：服务暂时不可用，与「业务上
 * 被拒」不是一回事。带上状态码（门户页常常是 200），解析报错原文只进 `raw` 给诊断，
 * 不上屏（规格 2026-11-25 G2）。
 */
export class ApiUnavailableError extends Error {
  constructor(
    public path: string,
    public status: number,
    public raw: string,
  ) {
    super(`non-JSON response (${status}): ${path}`);
    this.name = "ApiUnavailableError";
  }
}

/** REST 请求超过这么久没回：按失败处理，不再无限转圈。 */
export const API_TIMEOUT_MS = 15_000;

/** 请求在 API_TIMEOUT_MS 内没有应答。呈现上与断网同类（describeFailure 认它）。 */
export class ApiTimeoutError extends Error {
  constructor(
    public path: string,
    public timeoutMs: number,
  ) {
    super(`request timed out after ${timeoutMs}ms: ${path}`);
    this.name = "ApiTimeoutError";
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD" && csrfToken)
    headers.set("X-CSRF-Token", csrfToken);
  // 超时与调用方自带的 signal 合并：任何一个先到都中止请求。不用 AbortSignal.any，
  // 旧 iOS Safari 没有它。
  const ctl = new AbortController();
  const callerSignal = init.signal;
  const onCallerAbort = () => ctl.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  // 超时由这里自己记一笔，不靠 fetch 把中止原因原样交回：较旧的 WebKit 只拒绝一个
  // 通用的 AbortError，认不出它就不会按断网给重试。
  let timedOut: ApiTimeoutError | null = null;
  const timer = setTimeout(() => {
    timedOut = new ApiTimeoutError(path, API_TIMEOUT_MS);
    ctl.abort(timedOut);
  }, API_TIMEOUT_MS);
  let envelope: ApiEnvelope<T>;
  let res: Response;
  try {
    // 响应体也在计时之内：头到了、体不来同样是卡住。
    res = await fetch(path, {
      ...init,
      headers,
      credentials: "include",
      signal: ctl.signal,
    });
    // 先于解析响应体：401 就是 401，代理塞回一页 HTML 也一样。
    if (res.status === 401) unauthorizedHandler?.();
    try {
      envelope = await res.json();
    } catch (parseErr) {
      // 体没读完是超时/中止，照原样往外抛；只有「读完了却不是 JSON」才归服务不可用。
      if (timedOut || ctl.signal.aborted) throw parseErr;
      // 401 保住 401：登录失效比「服务不可用」更准，且全局处理已经喊过。
      if (res.status === 401) {
        throw new ApiError(401, "unauthorized", 401);
      }
      throw new ApiUnavailableError(
        path,
        res.status,
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
    }
  } catch (err) {
    throw timedOut ?? err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
  if (!res.ok || envelope.code !== 0) {
    throw new ApiError(envelope.code, envelope.msg, res.status);
  }
  return envelope.data;
}
