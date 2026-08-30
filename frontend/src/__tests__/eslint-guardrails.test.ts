import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * 守卫测试：加载**项目真实的** eslint.config.js，而不是就地拼一份配置。
 *
 * 这一点是整条守卫成立与否的关键——它验证的不只是「正则写对了」，
 * 还有「规则确实被挂进了配置、severity 是 error、作用域覆盖了 src/」。
 * 就地拼配置的守卫测试可以在规则根本没生效的情况下通过。
 *
 * 两个方向都要断言：违规样本必须报，合规样本必须不报。
 * 只断言前者的话，一条「什么都报」的规则也能通过。
 */
let eslint: ESLint;

/**
 * 预热要给足时间：**第一次** lintText 才会去解析整份 eslint.config.js（连同
 * typescript-eslint、插件、tsconfig），冷跑要好几秒；之后每次都在 1 秒以内。
 *
 * 这一步单独摆在 beforeAll 里，就是为了别把这笔一次性开销记到第一条用例的
 * 5 秒默认预算上 —— 记上去的话，这条守卫会随着整个套件的并发压力时红时绿，
 * 而它红起来跟它守的那条规则毫无关系。
 */
beforeAll(async () => {
  eslint = new ESLint({
    cwd: FRONTEND_ROOT,
    // 不传 overrideConfigFile → 走项目自身的 eslint.config.js
    errorOnUnmatchedPattern: false,
  });
  await eslint.lintText("export const warmup = 1;\n", {
    filePath: path.join(FRONTEND_ROOT, "src/warmup.ts"),
  });
}, 60_000);

/** 按 src/ 下的真实路径去 lint，这样文件才会命中 src 的配置段。 */
async function lintAs(filePath: string, code: string) {
  const results = await eslint.lintText(code, {
    filePath: path.join(FRONTEND_ROOT, filePath),
  });
  return results[0]?.messages ?? [];
}

function ruleIds(messages: Awaited<ReturnType<typeof lintAs>>) {
  return messages.map((m) => m.ruleId);
}

describe("design token guardrail", () => {
  it.each([
    [
      "tailwind palette class",
      `export const a = <div className="bg-slate-900" />;`,
    ],
    [
      "palette class with variant",
      `export const a = <div className="dark:bg-black/70" />;`,
    ],
    [
      "palette class with opacity",
      `export const a = <div className="text-red-500/50" />;`,
    ],
    ["bare palette colour", `export const a = <div className="text-white" />;`],
    ["hex literal", `export const c = "#0f172a";`],
    ["rgba literal", `export const c = "rgba(0, 0, 0, 0.18)";`],
    ["hsl literal", `export const c = "hsl(210 40% 98%)";`],
    [
      "inside template literal",
      'export const c = `border ${"x"} bg-zinc-800`;',
    ],
    [
      "arbitrary font size with token",
      `export const a = <div className="text-[13px]" />;`,
    ],
    [
      "responsive arbitrary font size",
      `export const a = <div className="sm:text-[15px]" />;`,
    ],
  ])("rejects %s", async (_name, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    expect(ruleIds(messages)).toContain("no-restricted-syntax");
  });

  it.each([
    [
      "semantic token class",
      `export const a = <div className="bg-background text-foreground" />;`,
    ],
    ["scrim token", `export const a = <div className="bg-scrim" />;`],
    ["shadow token", `export const a = <div className="shadow-overlay" />;`],
    [
      "destructive token",
      `export const a = <div className="bg-destructive text-destructive-foreground" />;`,
    ],
    [
      "non-colour arbitrary value",
      `export const a = <div className="w-[calc(100%-2rem)]" />;`,
    ],
    [
      "word that merely contains a colour name",
      `export const a = <div className="bg-background" />;`,
    ],
    [
      "arbitrary font size without token",
      `export const a = <div className="text-[9px]" />;`,
    ],
  ])("accepts %s", async (_name, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    expect(ruleIds(messages)).not.toContain("no-restricted-syntax");
  });

  // Tailwind v4 之后没有 tailwind.config.ts 了，token 定义在 globals.css 的 @theme 块里，
  // 而 eslint 不 lint CSS——原先那条「豁免 tailwind.config.ts」的断言失去了对象。
  // 换成反方向断言：配置文件也不再有写死颜色的特权，守卫只增不减。
  it("does not exempt config files any more; tokens live in CSS", async () => {
    const messages = await lintAs(
      "vite.config.ts",
      `export default { define: { c: "#0891b2" } };`,
    );
    expect(ruleIds(messages)).toContain("no-restricted-syntax");
  });
});

describe("native control guardrail", () => {
  // 本仓的基础组件全部来自共享包，但包里一度没有 Select / Checkbox / 搜索框，
  // 于是组织面就地退回了系统控件（系统控件走浏览器自己的配色，与 tokens.css 无关，
  // 深色下最先露馅）。这条守卫拦的是「再退让一次」。
  it.each([
    ["native select", `export const a = () => <select><option /></select>;`],
    ["native textarea", `export const a = () => <textarea value="" />;`],
    ["native checkbox", `export const a = () => <input type="checkbox" />;`],
    ["native radio", `export const a = () => <input type="radio" />;`],
    ["native search field", `export const a = () => <input type="search" />;`],
  ])("rejects %s", async (_name, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    expect(ruleIds(messages)).toContain("no-restricted-syntax");
  });

  it.each([
    [
      "shared package control",
      `export const a = ({ S }) => <S.Select value="" />;`,
    ],
    // 文件选择器没有可替代的原语形态，它总是藏起来由一颗按钮触发。
    [
      "hidden file input",
      `export const a = () => <input type="file" className="hidden" />;`,
    ],
    // 验证码那六个格子是自绘控件，不是能被 Input 顶替的普通字段。
    ["plain text input", `export const a = () => <input type="text" />;`],
  ])("accepts %s", async (_name, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    expect(ruleIds(messages)).not.toContain("no-restricted-syntax");
  });
});

describe("i18n guardrail", () => {
  it.each([
    ["literal JSX text", `export const a = () => <div>Save changes</div>;`],
    ["literal Chinese text", `export const a = () => <div>保存修改</div>;`],
    [
      "literal aria-label",
      `export const a = () => <button aria-label="Close" />;`,
    ],
    [
      "literal placeholder",
      `export const a = () => <input placeholder="Your name" />;`,
    ],
  ])("rejects %s", async (_name, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    expect(ruleIds(messages)).toContain("i18next/no-literal-string");
  });

  it.each([
    ["t() call", `export const a = ({ t }) => <div>{t('login.title')}</div>;`],
    [
      "t() in aria-label",
      `export const a = ({ t }) => <button aria-label={t('common.close')} />;`,
    ],
    ["punctuation only", `export const a = () => <div>:</div>;`],
    ["interpolated value", `export const a = ({ v }) => <div>{v}</div>;`],
  ])("accepts %s", async (_name, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    expect(ruleIds(messages)).not.toContain("i18next/no-literal-string");
  });

  it("exempts test files, which must construct violating samples", async () => {
    const messages = await lintAs(
      "src/__tests__/sample.test.tsx",
      `export const a = () => <div>Save changes</div>;`,
    );
    expect(ruleIds(messages)).not.toContain("i18next/no-literal-string");
  });
});

describe("guardrails are wired at error severity", () => {
  // severity 写成 'warn' 时，CI 里 `eslint .` 退出码仍是 0，守卫形同虚设。
  // package.json 的 lint 脚本另外加了 --max-warnings 0 兜底，但这里直接钉死 severity。
  it.each([
    ["no-restricted-syntax", `export const c = "#0f172a";`],
    [
      "i18next/no-literal-string",
      `export const a = () => <div>Save changes</div>;`,
    ],
  ])("%s reports as error (severity 2)", async (ruleId, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    const hit = messages.find((m) => m.ruleId === ruleId);
    expect(hit, `${ruleId} 没有报出来`).toBeDefined();
    expect(hit?.severity).toBe(2);
  });
});
