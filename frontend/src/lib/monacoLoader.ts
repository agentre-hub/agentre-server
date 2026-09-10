import type { MonacoNS } from "@agentre-hub/agentre-ui";

/**
 * 控制台这一侧唯一触碰真实 Monaco 的模块（规格 2026-09-08 决策 6）。
 *
 * 真实 monaco 走**动态 import**：懒加载成独立 chunk，不进首屏包 —— 控制台首屏
 * 不该为一个用户可能根本不点的预览付出这个体积。worker 环境同样动态引入（它靠
 * Vite 的 `?worker`，那是宿主的构建能力，共享包是纯 tsc 构建、进不去）。
 *
 * 体积面：只读预览不要 IntelliSense，所以只加载 editor.api（核心编辑器）+
 * basic-languages 的纯词法高亮，绝不引 editor.main 或 vs/language/*（那会带上
 * ts.worker 之类几 MB 的语言服务）。
 *
 * 单测把本模块整个 vi.mock 掉（见 file-preview-monaco.test.tsx）。
 */
export type { MonacoNS };

let cached: Promise<MonacoNS> | null = null;

/** 动态加载 Monaco 命名空间（幂等，进程内单例）。 */
export function loadMonaco(): Promise<MonacoNS> {
  cached ??= (async () => {
    await import("./monacoWorkerEnv");
    await import("monaco-editor/basic-languages/monaco.contribution");
    const monaco = await import("monaco-editor/editor/editor.api");
    // json 0.56 起移出了 basic-languages，补一门纯词法的 JSON —— 语法住在共享包，
    // 两端补的是同一门语言。
    const { registerJsonLanguage } = await import("@agentre-hub/agentre-ui");
    registerJsonLanguage(monaco);
    return monaco;
  })();
  return cached;
}
