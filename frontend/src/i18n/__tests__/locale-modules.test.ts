/// <reference types="vite/client" />
// import.meta.glob 由 Vite 注入，类型不在 tsconfig 默认的 lib 里；
// 只在这个文件按需引一次，不去动全局 types 配置。
import { describe, expect, it } from "vitest";

import en from "../locales/en";
import zhCN from "../locales/zh-CN";

/**
 * locale 按模块拆成 `locales/<lang>/<module>.json`，由同目录的 index.ts 合成
 * 一份 bundle 交给 i18next。拆开之后多了两种**静默**的错法，这里各拦一条：
 *
 *   1. 新增了 `<module>.json` 却忘了在 index.ts 里 import —— 整个模块的文案
 *      全部消失，界面上显示原始 key，而 locale-parity 只比 en / zh-CN 两边，
 *      两边一起漏就完全看不出来；
 *   2. import 了却挂错 key（`import chat from "./nav.json"`）—— 一棵子树被
 *      另一棵覆盖，同样不报错。
 *
 * 所以约定：**文件名即顶层 key**，并在这里机械核对磁盘上的文件与 bundle 一致。
 * 用 import.meta.glob 而不是 fs 读目录：它走的是 Vite 的解析，与真实构建同源。
 */
const files = import.meta.glob<Record<string, unknown>>("../locales/*/*.json", {
  eager: true,
  import: "default",
});

const BUNDLES: Record<string, Record<string, unknown>> = { en, "zh-CN": zhCN };

/** glob 的 key 形如 `../locales/zh-CN/appShell.json`。 */
function parsePath(path: string): { lang: string; module: string } {
  const [lang, file] = path.split("/").slice(-2);
  return { lang, module: file.replace(/\.json$/, "") };
}

function moduleFiles(lang: string): string[] {
  return Object.keys(files)
    .map(parsePath)
    .filter((p) => p.lang === lang)
    .map((p) => p.module)
    .sort();
}

describe("locale modules", () => {
  it.each(Object.keys(BUNDLES))(
    "%s: every module file is wired into the bundle, and vice versa",
    (lang) => {
      const modules = moduleFiles(lang);
      const keys = Object.keys(BUNDLES[lang]).sort();

      expect(modules, `locales/${lang}/ 下没有任何模块文件`).not.toEqual([]);
      expect(
        keys,
        `${lang} 的 index.ts 与目录不一致：` +
          `目录里有 ${modules.join(", ")}，bundle 里是 ${keys.join(", ")}`,
      ).toEqual(modules);
    },
  );

  it("each module file is mounted under the key of its own filename", () => {
    for (const [path, content] of Object.entries(files)) {
      const { lang, module } = parsePath(path);
      expect(
        BUNDLES[lang]?.[module],
        `locales/${lang}/${module}.json 没有挂在 ${module} 这个 key 上`,
      ).toEqual(content);
    }
  });

  it("both languages carry the same set of module files", () => {
    expect(moduleFiles("zh-CN")).toEqual(moduleFiles("en"));
  });
});
