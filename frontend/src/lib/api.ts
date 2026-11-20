type ApiEnvelope<T> = { code: number; msg: string; data: T };

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
  if (t) sessionStorage.setItem("csrf", t);
  else sessionStorage.removeItem("csrf");
}
export function loadCsrfToken() {
  csrfToken = sessionStorage.getItem("csrf");
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
    envelope = await res.json();
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
