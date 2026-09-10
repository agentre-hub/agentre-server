import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_CODES,
  DEVICE_FLOW_CODES,
  PASSKEY_CODES,
  PASSKEY_LOGIN_CODES,
} from "@/lib/errorCodes";

/**
 * 业务错误码契约守卫。
 *
 * 前端要按业务码分支（30205 就地标红、不跳页），而 internal/pkg/code/code.go
 * 的 Device Flow 段位是一串 iota：后端在段位中间插一个常量，后面每个码都会
 * 平移一位，而前端不会报任何错——它只会把「代码无效」认成别的东西。
 *
 * 手法与 design-token-contract.test.ts 相同：直接读那份权威源文件，
 * 在测试里重算 iota，再和前端常量表逐条比对。
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const CODE_GO = path.join(REPO_ROOT, "internal/pkg/code/code.go");

/** Device Flow 段位的起算值，见 code.go 的段位注释。 */
const BASE = 30200;

const go = fs.readFileSync(CODE_GO, "utf8");

/**
 * 取出以 `iota + BASE` 起算的那个 const 块，按声明顺序算出每个常量的值。
 *
 * 认「块里出现 iota + BASE」而不是认注释文字：注释可以改措辞，
 * 起算值改了才是真的换了段位。
 */
function segment(base: number): string[] {
  const block = [...go.matchAll(/const\s*\(([\s\S]*?)\n\)/g)]
    .map((m) => m[1])
    .find((body) => body.includes(`iota + ${base}`));
  if (!block) return [];
  return block
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .map((line) => line.split("=")[0].trim());
}

const names = segment(BASE);
const goCodes: Record<string, number> = {};
names.forEach((name, i) => (goCodes[name] = BASE + i));

describe("Device Flow 错误码契约", () => {
  it("code.go 里有以 30200 起算的 Device Flow 段位", () => {
    // 段位整体搬家（例如改成 30500）会让下面每条断言一起红，
    // 但失败信息看不出根因，所以先单独钉住段位本身。
    expect(names[0]).toBe("DeviceFlowAuthorizationPending");
  });

  it.each(Object.entries(DEVICE_FLOW_CODES))(
    "%s 与 code.go 算出来的值一致",
    (name, value) => {
      expect(
        goCodes[name],
        `${name} 在 code.go 的 Device Flow 段位里算出来不是 ${value}；` +
          `段位里插入或删除常量会让它后面的码整体平移，前端常量表要跟着改`,
      ).toBe(value);
    },
  );
});

/** 通行密钥段位的起算值，见 code.go 「通行密钥 30600~30699」的段位注释。 */
const PASSKEY_BASE = 30600;

const passkeyNames = segment(PASSKEY_BASE);
const passkeyGoCodes: Record<string, number> = {};
passkeyNames.forEach((name, i) => (passkeyGoCodes[name] = PASSKEY_BASE + i));

describe("通行密钥错误码契约", () => {
  it("code.go 里有以 30600 起算的通行密钥段位", () => {
    expect(passkeyNames[0]).toBe("PasskeyLimitReached");
  });

  // 只逐条比对 PASSKEY_CODES 自己声明的名字，不断言整段相等、不断言段位长度：
  // T6 与本任务同批，会往这一段末尾继续追加登录失败的码（PasskeyNotFound 之后），
  // 那些新名字不在 PASSKEY_CODES 里，段位变长不会让下面任何一条变红。
  it.each(Object.entries(PASSKEY_CODES))(
    "%s 与 code.go 算出来的值一致",
    (name, value) => {
      expect(
        passkeyGoCodes[name],
        `${name} 在 code.go 的通行密钥段位里算出来不是 ${value}；` +
          `段位里插入或删除常量会让它后面的码整体平移，前端常量表要跟着改`,
      ).toBe(value);
    },
  );
});

describe("通行密钥登录失败码契约", () => {
  // 登录页分支用的那几个码在同一段位的**末尾**，与 PASSKEY_CODES 分成两张表：
  // 账号页的注册 / 管理端点回不出它们。两张表都在这里逐条对回 code.go，
  // 因此谁都漂移不了。
  it.each(Object.entries(PASSKEY_LOGIN_CODES))(
    "%s 与 code.go 算出来的值一致",
    (name, value) => {
      expect(
        passkeyGoCodes[name],
        `${name} 在 code.go 的通行密钥段位里算出来不是 ${value}；` +
          `段位里插入或删除常量会让它后面的码整体平移，前端常量表要跟着改`,
      ).toBe(value);
    },
  );
});

/** 账号 / OAuth 段位的起算值，见 code.go 「账号 / OAuth 30100~30199」的段位注释。 */
const ACCOUNT_BASE = 30100;

const accountNames = segment(ACCOUNT_BASE);
const accountGoCodes: Record<string, number> = {};
accountNames.forEach((name, i) => (accountGoCodes[name] = ACCOUNT_BASE + i));

describe("账号错误码契约", () => {
  it("code.go 里有以 30100 起算的账号段位", () => {
    expect(accountNames[0]).toBe("UserNotFound");
  });

  // 账号闸门排在通行密钥登录建立会话之前，被封账号在那条路上拿到的就是
  // UserBanned；登录页要按它显示「已被封禁」而不是一句通用失败。
  it.each(Object.entries(ACCOUNT_CODES))(
    "%s 与 code.go 算出来的值一致",
    (name, value) => {
      expect(
        accountGoCodes[name],
        `${name} 在 code.go 的账号段位里算出来不是 ${value}；` +
          `段位里插入或删除常量会让它后面的码整体平移，前端常量表要跟着改`,
      ).toBe(value);
    },
  );
});
