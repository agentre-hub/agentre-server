// Harness 自身的单测:不开浏览器、不碰服务器,只驱动 run-e2e-web.mjs 与
// lib/drive-target.mjs 里那些纯函数。`make test-e2e` 会跑它,所以它是进 CI 的。
//
// testMatch 要跟着新的 harness spec 一起长:漏掉一个,那个文件就成了「本地能跑、
// CI 看不见」—— 和加了 build tag 是同一种假绿。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "web",
  testMatch:
    /(runner-config|runner-config-dir|runner-serve|drive-cli)\.spec\.ts/,
  reporter: "list",
});
