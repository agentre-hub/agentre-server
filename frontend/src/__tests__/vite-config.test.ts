import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 共享包在本站是从 GitHub tarball 装进 node_modules 的普通依赖，不是 workspace
 * 链接。把它们排除出依赖预构建（optimizeDeps.exclude），dev server 就把包里的
 * TS 源码当原始模块直接下发，`make dev` 首屏白屏，生产构建不受影响：
 *
 *   - 只有共享包 import 的第三方依赖（@tiptap/react、radix-ui……）不会被依赖扫描
 *     发现、不进预构建，它们依赖的 CJS 模块（use-sync-external-store/shim）以
 *     ESM 下发，命名导出缺失；
 *   - 同一个源文件以带 `?v=` 与不带两种 URL 各加载一份，ThemeProvider 与
 *     useTheme 拿到两个不同的 context（「useTheme must be used inside
 *     <ThemeProvider>」）。
 *
 * 桌面端不受影响，因为那边是 workspace:* 链接、源码不在 node_modules 下。
 *
 * vite.config.ts 一 import 就拉起 esbuild，在 jsdom 环境里跑不起来，所以这里按
 * 源码文本检查；真实行为（起 dev server、开页面无报错）由验证时的浏览器复现覆盖。
 */
describe("vite dev 依赖预构建", () => {
  const source = readFileSync(
    resolve(__dirname, "../../vite.config.ts"),
    "utf8",
  );
  const excludeLists = [...source.matchAll(/exclude\s*:\s*\[([^\]]*)\]/g)].map(
    (m) => m[1],
  );

  it.each(["@agentre-hub/agentre-ui", "@agentre-hub/agentre-wire"])(
    "Given 共享包 %s 装在 node_modules 里, When dev server 启动, Then 它参与依赖预构建而不是被排除",
    (pkg) => {
      for (const list of excludeLists) expect(list).not.toContain(`"${pkg}"`);
    },
  );
});
