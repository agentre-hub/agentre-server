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

beforeAll(() => {
  eslint = new ESLint({
    cwd: FRONTEND_ROOT,
    // 不传 overrideConfigFile → 走项目自身的 eslint.config.js
    errorOnUnmatchedPattern: false,
  });
});

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
  ])("accepts %s", async (_name, code) => {
    const messages = await lintAs("src/fixture.tsx", code);
    expect(ruleIds(messages)).not.toContain("no-restricted-syntax");
  });

  it("exempts tailwind.config.ts, where tokens are necessarily defined", async () => {
    const messages = await lintAs(
      "tailwind.config.ts",
      `export default { theme: { colors: { brand: "#0891b2" } } };`,
    );
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
