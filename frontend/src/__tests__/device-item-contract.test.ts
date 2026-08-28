import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 设备条目契约守卫。
 *
 * GET /v1/devices 的一条曾在 4 个文件里各声明一份 `interface DeviceItem`，
 * 而且已经漂了：Overview 那份少了 last_seen_at / status，Devices 那份多了
 * platform / version / is_this_device。四份都编译得过，谁也不会报错——只会在
 * 某个页面上少显示一段，或者在后端改字段时只改到其中一两处。
 *
 * 手法与 error-code-contract.test.ts / design-token-contract.test.ts 相同：
 * 直接读那份权威源文件（Go 的响应结构体），和前端这一份唯一声明逐字段比对。
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const DEVICE_GO = path.join(REPO_ROOT, "internal/api/device/device.go");
const DEVICES_TS = path.join(REPO_ROOT, "frontend/src/lib/devices.ts");
const FRONTEND_SRC = path.join(REPO_ROOT, "frontend/src");

/** 取 Go 结构体里每个字段的 json tag，按声明顺序。 */
function goJSONFields(source: string, structName: string): string[] {
  const block = source.match(
    new RegExp(`type ${structName} struct \\{([\\s\\S]*?)\\n\\}`),
  );
  if (!block) return [];
  return [...block[1].matchAll(/json:"([^",]+)"/g)].map((m) => m[1]);
}

/** 取 TS interface 里每个属性名，按声明顺序。 */
function tsFields(source: string, interfaceName: string): string[] {
  const block = source.match(
    new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`),
  );
  if (!block) return [];
  return [...block[1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("DeviceItem 契约", () => {
  it("字段与后端 ListDevicesItem 逐条对齐", () => {
    const want = goJSONFields(
      fs.readFileSync(DEVICE_GO, "utf8"),
      "ListDevicesItem",
    );
    expect(want.length).toBeGreaterThan(0);

    const got = tsFields(fs.readFileSync(DEVICES_TS, "utf8"), "DeviceItem");

    expect(got).toEqual(want);
  });

  // 端点也只有一处打。DeviceItem 收成一份之后，仍有 11 处各自 api<{devices: X}>
  // ("/v1/devices")，其中三处还自带一份更窄的别名（AppShell 的 DeviceRow、
  // Settings 与 enginePorts 各一个 DeviceDTO）——那是同一份漂移换了个名字接着漂。
  it("只有 lib/devices.ts 直接打这个端点", () => {
    const offenders = walk(FRONTEND_SRC)
      .filter((f) => !f.endsWith(path.join("lib", "devices.ts")))
      .filter((f) => !f.includes("__tests__"))
      // 只认真正的字符串实参。反引号排除在外：注释里用 `\/v1\/devices` 提一句
      // 端点名是正常的说明文字，不是一次调用。
      .filter((f) => /["']\/v1\/devices["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f));

    expect(offenders).toEqual([]);
  });

  it("整个前端只有这一处声明它", () => {
    const offenders = walk(FRONTEND_SRC)
      .filter((f) => !f.endsWith(path.join("lib", "devices.ts")))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) =>
        /\binterface\s+DeviceItem\b/.test(fs.readFileSync(f, "utf8")),
      )
      .map((f) => path.relative(REPO_ROOT, f));

    expect(offenders).toEqual([]);
  });
});
