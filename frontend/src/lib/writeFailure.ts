/**
 * 写失败里**传输层**那一类该怎么说（规格 2026-11-25 F5、G2）。
 *
 * `ApiTimeoutError` / `ApiUnavailableError` / fetch 自己的 TypeError 的 message 是给诊断看
 * 的英文原文（「request timed out after 15000ms: /v1/…」「non-JSON response (502): …」），
 * 不能上屏：换成当前语言的一句话。业务失败（`ApiError`，服务端给的真实原因）不归这里，
 * 返回 null，由调用方照旧处理。
 */
import i18n from "@/i18n";
import { ApiTimeoutError, ApiUnavailableError } from "@/lib/api";

export function transportFailureText(
  err: unknown,
  options: { create?: boolean } = {},
): string | null {
  if (err instanceof ApiTimeoutError) {
    return i18n.t(
      options.create
        ? "common.writeFailure.createTimeout"
        : "common.writeFailure.timeout",
    );
  }
  if (err instanceof ApiUnavailableError) {
    return i18n.t("common.writeFailure.unavailable", { status: err.status });
  }
  if (
    err instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(
      err.message,
    )
  ) {
    return i18n.t("common.writeFailure.network");
  }
  return null;
}

/** 传输层失败换成带本地化 message 的 Error（原值挂在 cause 上给诊断），其余原样。 */
export function localizeTransportFailure(
  err: unknown,
  options: { create?: boolean } = {},
): unknown {
  const text = transportFailureText(err, options);
  return text === null ? err : new Error(text, { cause: err });
}
