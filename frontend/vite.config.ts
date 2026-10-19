import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  // Tailwind v4 走 vite 插件，不再需要 postcss.config.js + autoprefixer。
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  // 共享包从 tarball 装进 node_modules，必须参与依赖预构建；排除它们会让 dev 白屏，
  // 原因见 src/__tests__/vite-config.test.ts。
  server: {
    port: 5174,
    proxy: { "/v1": { target: "http://127.0.0.1:8443", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
