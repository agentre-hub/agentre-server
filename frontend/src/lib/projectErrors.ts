/**
 * 一次写失败该给用户看什么。
 *
 * 服务端的 `ApiError.message` 不跟界面语言走（只按 Accept-Language 首选标签确切点名的
 * 语言包回，浏览器的区域标签落回中文），所以它从不进界面：
 * 认得的业务码说前端 i18n 文案，其余落到 `common.projectError.fallback` 这句通用话。
 */
import i18n from "@/i18n";
import { knownApiErrorText } from "@/lib/loadError";

export function projectFailureText(err: unknown): string {
  const t = (key: string) => i18n.t(key);
  return knownApiErrorText(err, t) ?? t("common.projectError.fallback");
}
