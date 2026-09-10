/**
 * 设计 token 守卫的规则数据。
 *
 * 单独抽成模块，是为了让 eslint.config.js 和 guard test
 * (src/__tests__/eslint-design-tokens.test.ts) 引用同一份来源——
 * 否则守卫测试可能在测一份和实际生效的配置不一样的正则。
 *
 * 约定本身写在 docs/design.md#colour-tokens。
 */

/** Tailwind 自带调色板的色名。用了它们就是绕过了 token 层。 */
const PALETTE = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "slate",
  "gray",
  "grey",
  "zinc",
  "neutral",
  "stone",
  "black",
  "white",
].join("|");

/** 会吃颜色的工具类前缀。 */
const COLOR_UTILITIES = [
  "text",
  "bg",
  "border",
  "ring",
  "from",
  "to",
  "via",
  "shadow",
  "fill",
  "stroke",
  "outline",
  "divide",
  "accent",
  "caret",
  "placeholder",
].join("|");

/** 任意变体前缀，如 dark: / hover: / focus-visible: / group-hover: */
const VARIANT = "(?:[a-z-]+:)*";

/**
 * 例：bg-slate-900/25、dark:bg-black/70、text-white、text-red-500/50
 *
 * 色阶和不透明度必须分成两个独立可选段：`text-red-500/50` 两者都有，
 * 合成一段（如 `(?:[-/][0-9]+)?`）只能吃掉其中一个，会漏掉这种最常见的写法。
 */
const SHADE = "(?:-[0-9]+)?";
// `/` 必须转义：no-restricted-syntax 的 selector 语法是 `Literal[value=/.../]`，
// 裸斜杠会被 esquery 当成正则结束符，报 "Unterminated group"。
const OPACITY = String.raw`(?:\/[0-9.]+)?`;
const LITERAL_COLOR_CLASS = `(?:^|[\\s"'\`])${VARIANT}(?:${COLOR_UTILITIES})-(?:${PALETTE})${SHADE}${OPACITY}(?:$|[\\s"'\`])`;

/** 例：#0f172a、rgba(0,0,0,.5)、hsl(210 40% 98%) */
const RAW_COLOR_VALUE = "(?:#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?)\\s*\\()";

const TOKEN_HINT =
  "颜色必须走 design token：改用 bg-background / text-foreground / border-border / bg-scrim 这类语义类名。" +
  " token 定义在 src/styles/globals.css，工具类映射在同一文件的 @theme 块。" +
  " 需要新颜色时先加 token，不要就地写字面量——否则深色模式下它不会跟着变。" +
  " 见 docs/design.md#colour-tokens";

/**
 * 阶梯上**已经有 token** 的那几档像素值。
 *
 * 判据刻意是「这个尺寸有没有对应的 token」，不是「所有字面像素都禁」：
 *   10 → text-3xs   11 → text-2xs   12 → text-xs
 *   13 → text-aux   14 → text-sm    15 → text-prose
 * 9px（设备指纹）与 16px 以上的展示字号（RFC 8628 确认码、总览的指标数字）
 * 目前没有对应档，为一两处特例各造一个 token 是把阶梯撑成词汇表，所以放行。
 * 哪天它们也成了档，往这个列表里加一个数字即可。
 *
 * 与 agentre 仓的同名模块保持逐字一致 —— 两端共用同一套阶梯，
 * 规则分叉了就等于阶梯分叉了。
 */
const TOKENED_FONT_SIZES = "10|11|12|13|14|15";

/**
 * 例：text-[13px]、sm:text-[15px]、group-hover:text-[11px]
 *
 * 不匹配收尾的 `]`：`[` 已经足够定位，少一个方括号就少一处 esquery 选择器
 * 解析上的不确定（那层语法里只有 `/` 一定要转义，但方括号能不写就不写）。
 */
const ARBITRARY_FONT_SIZE = `(?:^|[\\s"'\`])${VARIANT}text-\\[(?:${TOKENED_FONT_SIZES})px`;

const LADDER_HINT =
  "字号必须走阶梯：10→text-3xs、11→text-2xs、12→text-xs、13→text-aux、14→text-sm、15→text-prose。" +
  " 档位定义在共享包 @agentre-hub/agentre-ui 的 styles/tokens.css，两端与包共用同一份。" +
  " 写字面像素会绕开阶梯，且行高只能靠继承——同一档在不同父容器下高矮不一。" +
  " 确实需要一档新尺寸时先去包里加 token，不要就地写死。";

/**
 * no-restricted-syntax 的 selector 形式。
 * 走内建规则而不是自写插件：ESLint selector 已经能表达「字符串字面量匹配正则」。
 */
const restrictedSyntax = [
  {
    selector: `Literal[value=/${LITERAL_COLOR_CLASS}/]`,
    message: `禁止 Tailwind 调色板字面色类（如 bg-slate-900、text-white）。${TOKEN_HINT}`,
  },
  {
    selector: `TemplateElement[value.raw=/${LITERAL_COLOR_CLASS}/]`,
    message: `禁止 Tailwind 调色板字面色类（模板字符串里也不行）。${TOKEN_HINT}`,
  },
  {
    selector: `Literal[value=/${RAW_COLOR_VALUE}/]`,
    message: `禁止在 ts/tsx 里写死颜色值（#hex / rgb() / hsl()）。${TOKEN_HINT}`,
  },
  {
    selector: `TemplateElement[value.raw=/${RAW_COLOR_VALUE}/]`,
    message: `禁止在模板字符串里写死颜色值（#hex / rgb() / hsl()）。${TOKEN_HINT}`,
  },
  {
    selector: `Literal[value=/${ARBITRARY_FONT_SIZE}/]`,
    message: `禁止绕开字号阶梯的字面像素类（如 text-[13px]）。${LADDER_HINT}`,
  },
  {
    selector: `TemplateElement[value.raw=/${ARBITRARY_FONT_SIZE}/]`,
    message: `禁止绕开字号阶梯的字面像素类（模板字符串里也不行）。${LADDER_HINT}`,
  },
];

export {
  ARBITRARY_FONT_SIZE,
  LITERAL_COLOR_CLASS,
  PALETTE,
  RAW_COLOR_VALUE,
  TOKENED_FONT_SIZES,
  restrictedSyntax,
};
