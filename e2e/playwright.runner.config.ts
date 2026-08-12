import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "web",
  testMatch: "runner-config.spec.ts",
  reporter: "list",
});
