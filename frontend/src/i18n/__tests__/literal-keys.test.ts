/// <reference types="vite/client" />
// import.meta.glob 由 Vite 注入，类型不在 tsconfig 默认的 lib 里；
// 只在这个文件按需引一次，不去动全局 types 配置（与 locale-modules.test.ts 同）。
import { describe, expect, it } from "vitest";

import i18n from "../index";
import en from "../locales/en";
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

/**
 * 反向守卫：本站 `translation` bundle 里不应存在「没人用」的 key。
 *
 * 上面那条正向守卫只覆盖「代码 → 语言包」：删多了它不会红，界面却会直接印出
 * `session.decision.allow` 这样的字面量。这里补反方向：
 *
 *   每个叶子 key 都必须被「代码里的引用」或「显式白名单」覆盖。
 *
 * 「代码里的引用」不只算 `t("…")`——把 `t` 转手交给别的模块去拼时（`deviceKind.ts`
 * 的 `deviceKindLabel(kind, t)`），完整 key 永远不以字面量出现。所以这里同时收集
 * **整份源码文本里出现过的点分路径**（含测试与注释），并允许宿主前缀。
 *
 * 白名单每条都注明是哪段代码在拼。宁可写宽：一条误报会逼后来的人关掉整条守卫。
 */

/** 运行期拼出来的 key 前缀。`device.kind.` 是最典型的一份：`lib/deviceKind.ts` 用
 * `` const key = `device.kind.${kind}` `` 先拼再 `t(key)`。 */
const DYNAMIC_KEY_PREFIXES = [
  // pages/Account.tsx: t(`account.passkeys.errors.${PASSKEY_ERROR_KEY[…]}`)
  "account.passkeys.errors.",
  // components/AddDeviceGuide.tsx:
  //   t(`device.add.steps.${key}.title`) / `.hint` / `.done`
  "device.add.steps.",
  // pages/Device.tsx: t(`device.entry.errors.${codeError}`)
  "device.entry.errors.",
  // lib/deviceKind.ts: const key = `device.kind.${kind}`; t(key)
  "device.kind.",
  // pages/Login.tsx: t(`login.errors.${err}`)
  "login.errors.",
  // pages/org/OrgExecTargetSection.tsx:
  //   t(`org.detail.execTargets.skills.${catalog.status}`) / `.group.${group}` / `.state.${option}`
  "org.detail.execTargets.skills.",
  // pages/Overview.tsx: t(`overview.stats.range.${range}`)
  "overview.stats.range.",
  // components/session/SessionStatusBanner.tsx:
  //   t(`session.banner.${status}.title`) / `.titleUnknown` / `.body`
  "session.banner.",
  // components/session/SendFailureBubble.tsx:
  //   t(`session.sendFailure.${failure.kind}.title`) / `.titleUnknown` / `.body`
  "session.sendFailure.",
  // components/session/SessionIndex.tsx: t(`sessionIndex.filter.${option}`)
  "sessionIndex.filter.",
  // pages/chat/ChatIndexPanel.tsx: t(`sessionIndex.saveFailed.${saveFailure.kind}`)
  "sessionIndex.saveFailed.",
  // pages/Settings.tsx: t(`settings.sections.${section}`) / t(`settings.tabs.${key}`)
  "settings.sections.",
  "settings.tabs.",
];

type LocaleJson = { [key: string]: string | LocaleJson };

function flattenLocale(obj: LocaleJson, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flattenLocale(value, path);
  });
}

/** 源码文本里出现过的点分路径，及其每一级后缀。 */
function collectReferencedKeyPaths(): Set<string> {
  const paths = new Set<string>();
  const tokenPattern = /[A-Za-z_$][\w$]*(?:\.[\w$]+)+/g;

  for (const source of Object.values(SOURCES)) {
    for (const match of source.matchAll(tokenPattern)) {
      const token = match[0];
      paths.add(token);
      // 剥前缀：`i18n.t("a.b")` 与 `en.transcript.x` 都要能覆盖 bundle 里的 `a.b`。
      let dot = token.indexOf(".");
      while (dot !== -1) {
        paths.add(token.slice(dot + 1));
        dot = token.indexOf(".", dot + 1);
      }
    }
  }

  return paths;
}

describe("unused translation keys", () => {
  it("every translation key is referenced by code or an explicit dynamic-key whitelist", () => {
    const staticKeys = new Set(collectKeys().map(([key]) => key));

    // 守卫自证「不空过」：正则或 glob 哪天写错，静态 key 会塌成 0 条，
    // 下面的差集自动为空、守卫静默全绿。
    expect(staticKeys.size).toBeGreaterThan(100);

    const referencedPaths = collectReferencedKeyPaths();

    const isCovered = (key: string): boolean => {
      if (staticKeys.has(key)) return true;
      if (referencedPaths.has(key)) return true;
      return DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
    };

    const unused = flattenLocale(en as LocaleJson).filter((key) => {
      if (isCovered(key)) return false;
      // 复数键：bundle 里是 `x_one` / `x_other`，代码里调的是 base `x`。
      const base = key.replace(/_(?:one|other)$/, "");
      return base === key || !isCovered(base);
    });

    expect(
      unused,
      "这些 key 在代码里已经没有读者，删掉它们，或把「哪段代码在拼」写进白名单",
    ).toEqual([]);
  });
});
