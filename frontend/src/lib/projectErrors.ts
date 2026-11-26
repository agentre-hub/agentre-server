/**
 * 一次写失败该给用户看什么。
 *
 * 服务端的 `ApiError.message` 恒为中文（本服务没有语言中间件），所以它从不进界面：
 * 认得的业务码说前端 i18n 文案，其余落到 `common.projectError.fallback` 这句通用话。
 */
import i18n from "@/i18n";
import { knownApiErrorText } from "@/lib/loadError";

export function projectFailureText(err: unknown): string {
  const t = (key: string) => i18n.t(key);
  return knownApiErrorText(err, t) ?? t("common.projectError.fallback");
}
