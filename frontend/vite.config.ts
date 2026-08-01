import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5174,
    proxy: { "/v1": { target: "http://127.0.0.1:8443", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
