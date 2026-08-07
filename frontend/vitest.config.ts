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
  },
});
