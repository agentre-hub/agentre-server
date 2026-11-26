/**
 * 一次失败该给用户看什么（整句，没有「什么失败了」那半句时用）。
 *
 * 服务端的 `ApiError.message` 恒为中文（本服务没有语言中间件），所以它从不进界面。
 * 读失败带「什么没取到」那半句的，直接走 `describeFailure`（规格 2026-11-05-ux-polish W5）。
 */
import { apiPermissionFailure } from "@/lib/describeFailure";

/** 认得的 ApiError 码 → 当前语言的一句话；认不得返回 null，由调用方落兜底句。 */
export function knownApiErrorText(
  e: unknown,
  t: (key: string) => string,
): string | null {
  // 判据与 describeFailure 共用一份；这里只是没有「什么失败了」那半句，说整句。
  switch (apiPermissionFailure(e)) {
    case "signedOut":
      return t("common.apiError.signedOut");
    case "denied":
      return t("common.apiError.denied");
    default:
      return null;
  }
}
