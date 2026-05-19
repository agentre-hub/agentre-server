type ApiEnvelope<T> = { code: number; msg: string; data: T };

let csrfToken: string | null = null;
export function setCsrfToken(t: string | null) {
  csrfToken = t;
  if (t) sessionStorage.setItem('csrf', t);
  else sessionStorage.removeItem('csrf');
}
export function loadCsrfToken() {
  csrfToken = sessionStorage.getItem('csrf');
}
export function getCsrfToken() {
  return csrfToken;
}

export class ApiError extends Error {
  constructor(public code: number, message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  const envelope: ApiEnvelope<T> = await res.json();
  if (!res.ok || envelope.code !== 0) {
    throw new ApiError(envelope.code, envelope.msg, res.status);
  }
  return envelope.data;
}
