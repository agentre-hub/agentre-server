/**
 * Alert 内容槽守卫的规则数据。
 *
 * 共享包的 `Alert` 是一张两列 grid：第一列专留给图标，**没有图标时宽度是 0**
 * （`grid-cols-[0_1fr]`，有图标才变成 `[1rem_1fr]`），而 `col-start-2` 只写在
 * `AlertTitle` / `AlertDescription` 上。于是文案直接摆进 `<Alert>` 就落进那条
 * 0 宽的列里：2026-08-30 在真实控制台上量到「补齐失败」那句被压成 28px 宽、
 * 457px 高的一竖行字，用户看到的是一列竖着排的字。
 *
 * 这一档 jsdom 拦不住（它不算布局），只能在**源码形态**上拦：Alert 的直接子节点
 * 要么是图标（自闭合、无子节点），要么是 AlertTitle / AlertDescription。
 *
 * 与设计 token / 原生控件那两组共用同一条 `no-restricted-syntax`：规则数据单独
 * 成模块，eslint.config.js 与守卫测试（src/__tests__/eslint-guardrails.test.ts
 * 的 alert slot guardrail 一节）消费同一份来源。
 */

const HINT =
  "Alert 的文案要放进 <AlertDescription>（标题用 <AlertTitle>）。" +
  " Alert 是两列 grid，第一列留给图标、没图标时宽 0，只有这两个槽带 col-start-2；" +
  " 裸文案会落进 0 宽的第一列，被压成一列竖排的字。";

/** 带 col-start-2 的两个槽，也就是内容唯一的去处。 */
const CONTENT_SLOTS = ["AlertTitle", "AlertDescription"];

const IN_ALERT = 'JSXElement[openingElement.name.name="Alert"] > ';

const notASlot = CONTENT_SLOTS.map(
  (slot) => `:not([openingElement.name.name="${slot}"])`,
).join("");

/**
 * 表达式里**套着**槽的不算违规：`{cond && <AlertDescription/>}` 的门控写在外面
 * 还是里面，文案落在哪一列都一样。JSX 注释（`{/* … *\/}`）同理 —— 它是
 * JSXExpressionContainer，但里面是 JSXEmptyExpression，什么也不渲染。
 */
const notWrappingASlot = CONTENT_SLOTS.map(
  (slot) => `:not(:has(JSXElement[openingElement.name.name="${slot}"]))`,
).join("");

const alertSlotSyntax = [
  {
    selector:
      `${IN_ALERT}JSXExpressionContainer` +
      `:not([expression.type="JSXEmptyExpression"])${notWrappingASlot}`,
    message: `Alert 里不要直接放表达式。${HINT}`,
  },
  {
    selector: `${IN_ALERT}JSXText[value=/\\S/]`,
    message: `Alert 里不要直接放文本。${HINT}`,
  },
  {
    // 有子节点的元素 = 装着内容的容器（图标是自闭合的，不在此列）。
    selector: `${IN_ALERT}JSXElement[children.length>0]${notASlot}`,
    message: `Alert 里装内容的元素只能是 AlertTitle / AlertDescription。${HINT}`,
  },
];

export { HINT, CONTENT_SLOTS, alertSlotSyntax };
