import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { KNOWN_ERRORS } from "@/pages/Login";
import en from "@/i18n/locales/en.json";
import zhCN from "@/i18n/locales/zh-CN.json";

/**
 * 登录失败码契约守卫。
 *
 * Login.tsx 的注释写着「auth_ctr 只会重定向出这类值」——同源又是一句话，
 * 两边各存一份字面量。后端加一条 `/login?err=<新码>` 时前端不会报任何错：
 * 新码成形状但不在 KNOWN_ERRORS 里，于是走「原样透出」那条分支，用户在
 * 失败卡里读到的是 `oauth_email_unverified` 这样一串标识符，中英文都一样，
 * 而所有测试都是绿的。
 *
 * 手法与 error-code-contract / user-code-contract 相同：直接读那份权威源文件，
 * 把值抠出来和前端逐条比对。
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const AUTH_GO = path.join(REPO_ROOT, "internal/controller/auth_ctr/auth.go");

const go = fs.readFileSync(AUTH_GO, "utf8");

/** auth_ctr 里每一处 `/login?err=<value>` 重定向的 value，去重后排序。 */
function backendErrValues(): string[] {
  const found = [...go.matchAll(/["`]\/login\?err=([^"`&]+)["`]/g)].map(
    (m) => m[1],
  );
  return [...new Set(found)].sort();
}

/** 点号路径取 locale 里的字符串，取不到返回 null。 */
function lookup(locale: object, key: string): string | null {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | null)?.[part],
      locale,
    );
  return typeof value === "string" ? value : null;
}

describe("登录失败码契约（前端 ↔ auth_ctr）", () => {
  it("auth_ctr 里确实存在 /login?err= 重定向", () => {
    // 重定向整体改写（例如改成带 hash 的前端路由）会让下面每条断言一起红，
    // 但失败信息看不出根因，所以先单独钉住这件事本身。
    expect(backendErrValues().length).toBeGreaterThan(0);
  });

  it("KNOWN_ERRORS 与后端重定向出的值逐条相同", () => {
    expect(
      [...KNOWN_ERRORS].sort(),
      "internal/controller/auth_ctr/auth.go 的 /login?err= 值集合变了：" +
        "多出来的码前端会当成未收录码原样透出一串标识符给用户；" +
        "少掉的码是一条永远走不到的死分支，连同它的两条 locale 文案",
    ).toEqual(backendErrValues());
  });

  it.each(KNOWN_ERRORS)("%s 在两个 locale 里都有文案", (name) => {
    const key = `login.errors.${name}`;
    expect(lookup(en, key), `en.json 缺 ${key}`).toBeTruthy();
    expect(lookup(zhCN, key), `zh-CN.json 缺 ${key}`).toBeTruthy();
  });
});
