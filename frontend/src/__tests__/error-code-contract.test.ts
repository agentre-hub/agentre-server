import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEVICE_FLOW_CODES } from "@/lib/errorCodes";

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
