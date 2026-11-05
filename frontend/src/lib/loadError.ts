/**
 * 一次读失败该给用户看什么。
 *
 * 服务端的 `ApiError.message` 恒为中文（本服务没有语言中间件），所以它从不进界面。
 * 读失败经 `describeFailure` 分类（规格 2026-11-05-ux-polish W5）：调用方给「什么没取到」
 * 那半句，原因由分类给——离线说断网、登录失效说登录失效、认不出的只说那半句。不能
 * 静默吞掉：那会让页面渲染成「还没有任何设备」，而用户名下的设备一台没少。
 *
 * `whatKey` 是调用方那一页自己的半句文案键：同一套分类，各页说各页的事。
 */
import { ApiError } from "@/lib/api";
import { describeFailure, type FailureContext } from "@/lib/describeFailure";
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
  t: FailureContext["t"],
  whatKey: string,
): string {
  return describeFailure(e, { t, what: t(whatKey) }).message;
}
