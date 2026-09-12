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
 * 是这些数字的唯一权威。它以前用 iota 分段派生：后端在段位中间插一个常量，后面每个
 * 码都会平移一位，而前端不会报任何错——它只会把「代码无效」认成别的东西。现在编号
 * 一律显式写出，那份危险没了，但「改一个数字」仍然不会让前端编译不过，所以这条守卫
 * 照旧要盯着：直接读那份权威源文件，把显式编号取出来逐条比对。
 *
 * 手法与 design-token-contract.test.ts 相同：读权威源，逐条比对。
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const CODE_GO = path.join(REPO_ROOT, "internal/pkg/code/code.go");

const go = fs.readFileSync(CODE_GO, "utf8");

/** code.go 里「常量名 → 显式编号」的全部映射。 */
const goCodes = new Map<string, number>();
for (const match of go.matchAll(/^\s*(\w+)\s*=\s*(\d+)\s*$/gm)) {
  goCodes.set(match[1], Number(match[2]));
}

/**
 * 某个段位里声明的常量名，按编号升序。
 *
 * 段位就是 `iota + <百位>` 那一段的取值区间，现在由显式编号自己表达：落在这个区间里的
 * 就是这一段的人。用它钉住「段位整体搬家」这类事故——那会让下面每条断言一起红，
 * 而失败信息看不出根因，所以先单独把段位本身钉一下。
 */
function segment(base: number): string[] {
  return [...goCodes.entries()]
    .filter(([, value]) => value >= base && value < base + 100)
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
}

const driftHint = (name: string, base: number) =>
  `${name} 在 code.go 的 ${base} 段位里的显式编号与前端常量表不一致；` +
  `改名、删掉或改数值都要两边一起改（编号一经发出就不再复用）。`;

const DEVICE_FLOW_BASE = 30200;
const deviceFlowNames = segment(DEVICE_FLOW_BASE);

describe("Device Flow 错误码契约", () => {
  it("code.go 里有 Device Flow 段位", () => {
    expect(deviceFlowNames[0]).toBe("DeviceFlowAuthorizationPending");
  });

  it.each(Object.entries(DEVICE_FLOW_CODES))(
    "%s 与 code.go 的显式编号一致",
    (name, value) => {
      expect(goCodes.get(name), driftHint(name, DEVICE_FLOW_BASE)).toBe(value);
    },
  );
});

const PASSKEY_BASE = 30600;
const passkeyNames = segment(PASSKEY_BASE);

describe("通行密钥错误码契约", () => {
  it("code.go 里有通行密钥段位", () => {
    expect(passkeyNames[0]).toBe("PasskeyLimitReached");
  });

  // 只逐条比对 PASSKEY_CODES 自己声明的名字，不断言整段相等、不断言段位长度：
  // 登录失败的码与注册 / 管理的码同段但分成两张表，段位继续往后追加不会让下面变红。
  it.each(Object.entries(PASSKEY_CODES))(
    "%s 与 code.go 的显式编号一致",
    (name, value) => {
      expect(goCodes.get(name), driftHint(name, PASSKEY_BASE)).toBe(value);
    },
  );
});

describe("通行密钥登录失败码契约", () => {
  it.each(Object.entries(PASSKEY_LOGIN_CODES))(
    "%s 与 code.go 的显式编号一致",
    (name, value) => {
      expect(goCodes.get(name), driftHint(name, PASSKEY_BASE)).toBe(value);
    },
  );
});

const ACCOUNT_BASE = 30100;
const accountNames = segment(ACCOUNT_BASE);

describe("账号错误码契约", () => {
  it("code.go 里有账号 / OAuth 段位", () => {
    expect(accountNames[0]).toBe("UserNotFound");
  });

  // 账号闸门排在通行密钥登录建立会话之前，被封账号在那条路上拿到的就是
  // UserBanned；登录页要按它显示「已被封禁」而不是一句通用失败。
  it.each(Object.entries(ACCOUNT_CODES))(
    "%s 与 code.go 的显式编号一致",
    (name, value) => {
      expect(goCodes.get(name), driftHint(name, ACCOUNT_BASE)).toBe(value);
    },
  );
});
