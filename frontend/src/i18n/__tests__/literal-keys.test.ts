/// <reference types="vite/client" />
// import.meta.glob 由 Vite 注入，类型不在 tsconfig 默认的 lib 里；
// 只在这个文件按需引一次，不去动全局 types 配置（与 locale-modules.test.ts 同）。
import { describe, expect, it } from "vitest";

import i18n from "../index";
import { AGENTRE_UI_NAMESPACE } from "@agentre-hub/agentre-ui/i18n";

/**
 * 守卫：代码里写死的每一个 `t("…")` 键，都必须真的解得出来。
 *
 * 起因是一个界面上肉眼可见、却没有任何东西会红的缺陷：`DeviceUpgrade.tsx` 引了
 * `device.add.copy` 与 `device.add.copied`，而这两个键在 **en 与 zh-CN 里都不存在**，
 * 按钮上于是直接印出 `device.add.copy` 这一串。
 *
 * 隔壁的 `locale-parity.test.ts` 抓不到它：那一条比的是**两种语言之间**的对齐，
 * 而这两个键两边都缺，对齐得好好的。缺的是「代码 → 语言包」这个方向的检查。
 *
 * # 射程与盲区
 *
 * 只认**字面量**键：`t("a.b")` / `t('a.b')`，含 `i18n.t("a.b")`。拼出来的动态键
 * （模板字符串、变量、条件表达式）本来就静态看不出来，扫不到——这条守卫不假装
 * 覆盖它们。即便如此，本仓绝大多数 `t()` 都是字面量，`device.add.copy` 这一类
 * 一次就抓得着。
 *
 * 两个 namespace 都算数：本站文案在 `translation`，共享包 `@agentre-hub/agentre-ui`
 * 的在 `agentreUi`（宿主经 `useUiTranslation()` 取）。任何一边解得出来就算数，
 * 免得给包里的键判假阳性。
 *
 * 复数键也算数：`t("a.b", { count })` 在语言包里是 `a.b_one` / `a.b_other`，基键
 * 本身并不存在（`appShell.nav.chatBadge.unread` 就是这样一条真实的键）。所以带
 * count 再问一次，别把它们误判成缺失。
 */

// 只扫生产源码：测试文件里也会出现 t("…")，但它们常常是自己造的桩，不该由语言包负责。
const SOURCES = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** `t("a.b")` / `t('a.b')` / `i18n.t("a.b")`。`\b` 挡掉 format( 这类以 t 结尾的名字。 */
const LITERAL_T_CALL = /\bt\(\s*(["'])([^"'\n]+)\1/g;

function isTestFile(path: string): boolean {
  return path.includes("/__tests__/") || /\.test\.tsx?$/.test(path);
}

/**
 * 注释行不算。语言包自己的文档注释里就写着 `t("appShell.…")` 这样的示例，
 * 照扫会得到一条永远解不出来的假键。
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

function literalKeysIn(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !isCommentLine(line))
    .flatMap((line) => [...line.matchAll(LITERAL_T_CALL)].map((m) => m[2]));
}

/**
 * 这个键在 en 里解得出来吗。两个 namespace 各问一遍，每遍再带 count 问一次
 * （复数键的基键本身不存在）。
 */
function resolvesInEnglish(key: string): boolean {
  const probes = [{}, { count: 1 }, { count: 2 }];
  return [{}, { ns: AGENTRE_UI_NAMESPACE }].some((namespace) =>
    probes.some((probe) =>
      i18n.exists(key, { lng: "en", ...namespace, ...probe }),
    ),
  );
}

/** 收集 [键, 出处] —— 出处让失败信息直接指到文件，不必再去 grep。 */
function collectKeys(): Array<[string, string]> {
  return Object.entries(SOURCES)
    .filter(([path]) => !isTestFile(path))
    .flatMap(([path, source]) =>
      literalKeysIn(source).map((key): [string, string] => [key, path]),
    );
}

describe("literal t() keys", () => {
  it("scans a meaningful number of source files", () => {
    // 这一条守的是守卫本身：glob 或过滤哪天写错，上面那条会「一个键都没扫到」
    // 而依然全绿。
    const keys = collectKeys();
    expect(keys.length).toBeGreaterThan(100);
  });

  it("every literal key resolves in en", () => {
    const missing = collectKeys()
      .filter(([key]) => !resolvesInEnglish(key))
      .map(([key, path]) => `${key}  （${path}）`);

    expect(missing, "这些键在语言包里不存在，界面上会直接印出键名本身").toEqual(
      [],
    );
  });
});
