/**
 * 一次读失败该给用户看什么。
 *
 * 服务端的 `ApiError.message` 恒为中文（本服务没有语言中间件），所以它从不进界面：
 * 认得的业务码换成前端 i18n 文案（`knownApiErrorText`），其余——代理返回非 JSON 的
 * 502 → SyntaxError、离线 → TypeError、不认得的码——一律落到调用方那一页自己的兜底
 * 句。不能静默吞掉：那会让页面渲染成「还没有任何设备」，而用户名下的设备一台没少。
 *
 * `fallbackKey` 是调用方那一页自己的兜底文案键：同一套判断，各页说各页的话。
 */
import { ApiError } from "@/lib/api";
import { FAILURE_CODES } from "@/lib/errorCodes";

/** 认得的 ApiError 码 → 当前语言的一句话；认不得返回 null，由调用方落兜底句。 */
export function knownApiErrorText(
  e: unknown,
  t: (key: string) => string,
): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401 || e.code === FAILURE_CODES.Unauthorized) {
    return t("common.apiError.signedOut");
  }
  if (e.status === 403 || e.code === FAILURE_CODES.Forbidden) {
    return t("common.apiError.denied");
  }
  return null;
}

export function loadErrorText(
  e: unknown,
  t: (key: string) => string,
  fallbackKey: string,
): string {
  return knownApiErrorText(e, t) ?? t(fallbackKey);
}
