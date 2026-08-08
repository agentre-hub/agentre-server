/**
 * 设备码（RFC 8628 的 user_code）的字母表与归一化规则。
 *
 * 从 pages/Device.tsx 提到这里，是因为六格码格组件和提交逻辑都要用同一套规则：
 * 各写一份的话，「哪些字符算合法」迟早会在两处分叉，而分叉的那一天
 * 用户看到的是「输入框收了这个字符，但提交说它非法」。
 *
 * 字母表与后端 internal/pkg/usercode 同源：去掉了 0/O/1/I 这些易混字形。
 */

export const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** 设备码长度（不含展示用的连字符）。 */
export const CODE_LENGTH = 6;

/**
 * 严格归一化：去空格与连字符、转大写、逐字符校验字母表，
 * 通过则返回后端要的 `ABC-DEF` 形态，否则返回 null。
 *
 * 「返回 null」覆盖两种情况——长度不对、含字母表外字符。二者都按
 * 就地校验处理（spec「失败路径」），不发请求。
 */
export function normalize(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "").split("");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const c of cleaned) if (!ALPHABET.includes(c)) return null;
  return cleaned.slice(0, 3).join("") + "-" + cleaned.slice(3).join("");
}

/**
 * 宽松清洗：转大写后只留字母表内的字符。
 *
 * 用在「还没成形」的输入上：逐格键入、半截粘贴、URL 里带来的 user_code。
 * 与 normalize 的区别是它不拒绝，只过滤——码格里不该出现一个我们明知
 * 非法的字符，用户却要等到点提交才知道。
 */
export function sanitize(input: string): string {
  return input
    .toUpperCase()
    .split("")
    .filter((c) => ALPHABET.includes(c))
    .join("");
}

/** 把任意输入摊成定长六格（不足补空串），供受控码格组件使用。 */
export function toChars(input: string): string[] {
  const chars = sanitize(input).slice(0, CODE_LENGTH).split("");
  return Array.from({ length: CODE_LENGTH }, (_, i) => chars[i] ?? "");
}
