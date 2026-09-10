import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    globals: true,
    // jsdom 缺的浏览器设施在这里补齐一次，见 src/test/setup.ts。
    setupFiles: ["./src/test/setup.ts"],
    server: {
      deps: {
        // 两个共享包都必须走打包器，不能被 externalize 成裸 Node ESM。
        //
        // agentre-ui 的 dist 里有 `import en from "./locales/en.json"` 与目录
        // 说明符（`from "./i18n"`）；agentre-wire 的 dist 里是无扩展名的相对
        // 说明符（`from "./runtime"`）。它们在 Vite / Rollup 下都能解析，但
        // Node 的 ESM 解析器要求完整文件说明符，会直接报
        // `Directory import ... is not supported` / `ERR_MODULE_NOT_FOUND`。
        //
        // vitest 默认把 node_modules 里的依赖 externalize 掉交给 Node，于是
        // 用例里的解析行为与 `vite build` 产物**不一致**。inline 就是让测试
        // 走真实构建那条路径。
        inline: ["@agentre-hub/agentre-ui", "@agentre-hub/agentre-wire"],
      },
    },
  },
});
