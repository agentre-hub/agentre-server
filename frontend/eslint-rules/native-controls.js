/**
 * 原生表单控件守卫的规则数据。
 *
 * 本仓的基础组件全部来自共享包 @agentre-hub/agentre-ui，但包里一度没有 Select /
 * Checkbox / 搜索框：2026-08-23 之前，组织面的上级部门、负责人、新建对话框里的部门
 * 都是原生 `<select>`，系统提示词是原生 `<textarea>`，三处搜索框各手搓了一遍。系统控件
 * 走浏览器自己的配色，与 tokens.css 那张表无关 —— 深色下最先露馅的就是它们。
 *
 * 与设计 token 那组共用同一条 `no-restricted-syntax`：规则数据单独成模块，守卫测试
 * 与 eslint.config.js 消费同一份来源（见 src/__tests__/eslint-guardrails.test.ts 的
 * native control guardrail 一节）。
 *
 * 与桌面端 `agentre/frontend/eslint-rules/native-controls.js` 是**两份一样的规则数据**，
 * 和早已如此的 design-tokens.js 同一条：lint 配置是宿主自己的工装，共享包不发它。
 * 改一处记得改另一处。
 *
 * **豁免只有一处**：`<input type="file">` 没有可替代的原语形态，它总是藏起来由一颗
 * 按钮触发。这一条由选择器本身表达（只点名 checkbox / radio / search），不靠文件豁免
 * —— 本仓没有原语实现，`components/ui/` 下只剩一个 card.tsx。
 */

const HINT =
  "表单控件一律走共享包 @agentre-hub/agentre-ui：" +
  " Select / Checkbox / Input / Textarea / SearchInput。原生控件由浏览器自己上色，" +
  " 与 tokens.css 无关，深色主题下必然对不上；缺哪个原语就先往包里补哪个，不要就地退让。";

/** `<input type="…">` 里这几种都有对应的原语。 */
const REPLACEABLE_INPUT_TYPES = ["checkbox", "radio", "search"];

const nativeControlSyntax = [
  {
    selector: 'JSXOpeningElement[name.name="select"]',
    message: `禁止原生 <select>。${HINT}`,
  },
  {
    selector: 'JSXOpeningElement[name.name="textarea"]',
    message: `禁止原生 <textarea>。${HINT}`,
  },
  ...REPLACEABLE_INPUT_TYPES.map((type) => ({
    selector: `JSXOpeningElement[name.name="input"] > JSXAttribute[name.name="type"][value.value="${type}"]`,
    message: `禁止原生 <input type="${type}">。${HINT}`,
  })),
];

export { HINT, REPLACEABLE_INPUT_TYPES, nativeControlSyntax };
