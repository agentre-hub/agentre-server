import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALPHABET, CODE_LENGTH, normalize } from "@/lib/userCode";

/**
 * 设备码字母表契约守卫。
 *
 * lib/userCode.ts 的注释写着「字母表与后端 internal/pkg/usercode 同源」——
 * 但同源只是一句话，两边各存一份字面量，改一边不会让另一边报任何错。
 * 后端要是按自己 package 注释里说的那样再去掉一个字形（注释说去了 L，
 * 实际字母表里 L 还在），用户在设备上拿到的合法码里就会出现前端不认的字符：
 * 六个码格当场把它挡下来，人一辈子也进不去，而所有测试都是绿的。
 *
 * 手法与 error-code-contract.test.ts 相同：直接读那份权威源文件，
 * 把常量抠出来和前端逐字比对。
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const USERCODE_GO = path.join(REPO_ROOT, "internal/pkg/usercode/usercode.go");

const go = fs.readFileSync(USERCODE_GO, "utf8");

/** 取 `const <name> = "..."` / `const <name> = <数字>` 的字面量，取不到返回 null。 */
function goConst(name: string): string | null {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*(?:"([^"]*)"|(\\d+))`).exec(
    go,
  );
  if (!m) return null;
  return m[1] ?? m[2];
}

describe("设备码契约（前端 ↔ internal/pkg/usercode）", () => {
  it("字母表逐字相同", () => {
    expect(
      goConst("Alphabet"),
      "internal/pkg/usercode 的 Alphabet 变了，lib/userCode.ts 的 ALPHABET 要跟着改；" +
        "两边不一致时，用户会拿到一个后端发得出、前端却不肯收的设备码",
    ).toBe(ALPHABET);
  });

  it("码长相同", () => {
    expect(goConst("codeLen")).toBe(String(CODE_LENGTH));
  });

  it("归一化后的形态就是后端 Normalize 返回的 XXX-XXX", () => {
    // 后端 Normalize 返回 string(cleaned[:3]) + "-" + string(cleaned[3:])。
    // 这条同时钉住「前端提交的是带连字符的形态」——approve/deny 拿的就是它。
    expect(normalize("a4f7q2")).toBe("A4F-7Q2");
    expect(normalize("a4f-7q2")).toBe("A4F-7Q2");
  });

  it("字母表外的字符一律拒绝，长度不对也拒绝", () => {
    for (const bad of ["0", "O", "1", "I"]) {
      expect(ALPHABET.includes(bad), `${bad} 不该在字母表里`).toBe(false);
      expect(normalize("A4F7Q" + bad)).toBeNull();
    }
    expect(normalize("A4F7Q")).toBeNull();
    expect(normalize("A4F7Q22")).toBeNull();
  });
});
