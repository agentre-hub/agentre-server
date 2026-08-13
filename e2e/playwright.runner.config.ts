// Runner 与 drive 的纯逻辑单测：不开浏览器、不连接 MySQL/Redis，也不依赖即将
// 删除的旧 web/ 全链路目录。这里覆盖配置安全边界、脱敏、serve handoff、信号收尾
// 与本地人工验证的机械护栏。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "runner",
  testMatch: /.*\.spec\.ts/,
  reporter: "list",
  workers: 1,
});
