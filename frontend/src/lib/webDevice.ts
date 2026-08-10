/**
 * 浏览器设备身份（R1 消费侧）：本浏览器按持久化指纹换到一台 kind=web 设备与设备 JWT。
 *
 * 服务端端点 T3 已落地（POST /v1/oauth/device/register，SessionAuth+CSRF，按
 * (user_id, fingerprint) 幂等）。本模块是它的唯一消费方：
 *   - 指纹持久化在 localStorage（同一浏览器永远同一台设备，决策 6）；
 *   - 设备 JWT 存在 sessionStorage（本次标签页会话内复用，关标签即失效，重新注册
 *     按指纹幂等、不新增设备行）；
 *   - 令牌临近过期（JWT exp，服务端 access_ttl=15m）时重新注册换新；
 *   - 一旦探测到本设备已被解除授权（R11），持久化一个 revoked 标记，此后不再自动
 *     重新注册 —— 否则每次刷新都按指纹幂等重注册，等于把解除授权绕过去（R2 的
 *     「刷新页面仍表达为已解除授权」）。
 */
import { api, ApiError } from "@/lib/api";

export interface WebDevice {
  fingerprint: string;
  accessToken: string;
  deviceId: number;
}

/** 解除授权后的持久标记；值为被撤销的指纹。 */
export class WebDeviceRevokedError extends Error {
  constructor() {
    super("web device has been revoked");
    this.name = "WebDeviceRevokedError";
  }
}

const FP_KEY = "agentre.deviceFingerprint";
const TOKEN_KEY = "agentre.webDeviceToken";
const REVOKED_KEY = "agentre.webDeviceRevoked";

export function getFingerprint(): string | null {
  return window.localStorage.getItem(FP_KEY);
}

export function createFingerprint(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getStoredWebDevice(): WebDevice | null {
  const fp = window.localStorage.getItem(FP_KEY);
  const raw = window.sessionStorage.getItem(TOKEN_KEY);
  if (!fp || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      accessToken?: string;
      deviceId?: number;
    };
    if (!parsed.accessToken || typeof parsed.deviceId !== "number") return null;
    return {
      fingerprint: fp,
      accessToken: parsed.accessToken,
      deviceId: parsed.deviceId,
    };
  } catch {
    return null;
  }
}

/** JWT 的 exp（毫秒）；读不出（老格式 / 坏 token）返回 null。 */
export function tokenExpiryMs(accessToken: string): number | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      window.atob(payload.replace(/-/g, "+").replace(/_/g, "/")).toString(),
    ) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** 本浏览器是否已被解除授权（R11 的持久标记）。 */
export function isWebDeviceRevoked(): boolean {
  const fp = getFingerprint();
  return !!fp && window.localStorage.getItem(REVOKED_KEY) === fp;
}

/** 探测到解除授权后落标记，让后续刷新 / 注册请求都不再绕过。 */
export function markWebDeviceRevoked(): void {
  const fp = getFingerprint();
  if (fp) window.localStorage.setItem(REVOKED_KEY, fp);
}

/** 用户重新登录前清除 revoked 标记（解除授权后重新登录可再注册一台新设备）。 */
export function clearWebDeviceRevoked(): void {
  window.localStorage.removeItem(REVOKED_KEY);
}

export function clearWebDeviceToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

function browserName(): string {
  const ua = window.navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/")) return "Safari";
  return "Browser";
}

export function platformName(): string {
  const ua = window.navigator.userAgent;
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  const p = window.navigator.platform ?? "";
  if (/Mac/.test(p)) return "macOS";
  if (/Win/.test(p)) return "Windows";
  if (/Linux/.test(p)) return "Linux";
  return p || "Web";
}

/** 「Chrome · macOS」形的设备显示名（R19），随 runtime.run 的 sourceDeviceName 上报。 */
export function deviceDisplayName(): string {
  return `${browserName()} · ${platformName()}`;
}

interface RegisterResponse {
  access_token: string;
  device_id: number;
}

/**
 * 确保本浏览器有可用的设备身份。已缓存且未过期 → 直接复用；否则按指纹幂等重新
 * 注册换新 token。已被解除授权 → 抛 WebDeviceRevokedError（不自动重新注册）。
 */
export async function ensureWebDevice(): Promise<WebDevice> {
  if (isWebDeviceRevoked()) throw new WebDeviceRevokedError();
  const stored = getStoredWebDevice();
  if (stored) {
    const exp = tokenExpiryMs(stored.accessToken);
    if (exp !== null && exp > Date.now() + 60_000) return stored;
  }
  const fingerprint = getFingerprint() ?? createFingerprint();
  window.localStorage.setItem(FP_KEY, fingerprint);
  let res: RegisterResponse;
  try {
    res = await api<RegisterResponse>("/v1/oauth/device/register", {
      method: "POST",
      body: JSON.stringify({
        fingerprint,
        platform: platformName(),
        version: "1",
        name: deviceDisplayName(),
      }),
    });
  } catch (e) {
    // 服务端在同指纹的设备行已被解除授权时回 403（R2 的执行点，不复活那一行）。
    // 落标记并转成 WebDeviceRevokedError，让界面按 R11 说「这台设备已被解除授权，
    // 须重新登录」，而不是当成故障不停重试。
    if (e instanceof ApiError && e.status === 403) {
      markWebDeviceRevoked();
      throw new WebDeviceRevokedError();
    }
    throw e;
  }
  const web: WebDevice = {
    fingerprint,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
  window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify(web));
  return web;
}
