/**
 * 把一个 unknown 的失败折成给用户看的字符串。
 *
 * `fallback` 只对付那些既不是 Error 也不是字符串的值：undefined（一个空 reject）、
 * 一个裸对象。调用方按自己的语境给兜底，组织面给「unknown error」。
 */
export function errorText(err: unknown, fallback = "unknown error"): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}
