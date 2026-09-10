import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    globals: true,
    // 一条用例的预算。原厂默认是 5000ms —— 整套并发跑（默认按 CPU 数开 worker，
    // 这台机器 8 个）时 worker 会被卡住超过它，于是偶发红在**每次都不同**的文件上，
    // 隔离与复跑都绿（诊断：.dev-kit/artifacts/2026-09-10-frontend-suite-flake/）。
    //
    // 判据不是猜的：整套串行（--maxWorkers=1）跑 2/2 全绿、并行 1/3 红，跨文件并发
    // 是必要条件；而这些用例等的方式本来就是对的，改写断言修不掉它们。
    //
    // 取 15s 的代价要说清楚：**真卡死的用例现在要 15 秒才报出来**，整套最坏情况随之
    // 变长。换来的是 CI / 本机忙时不再假红。降并发是另一条出口，但整套会从 ~60s 变成
    // ~250s，那个代价每天都要付，而这个只在真出问题时付。
    testTimeout: 15_000,
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
