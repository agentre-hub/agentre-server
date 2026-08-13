import { test, expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupHasResidue,
  cleanupRunID,
  handoffIsLive,
  installSignalHandlers,
  parseRunnerArgs,
  prepareHandoff,
  rateLimitClientIP,
  removeOwnedHandoff,
  runtimePaths,
  playwrightInvocation,
  seedInvocation,
  serverInvocation,
  serveEnvPayload,
} from "../run.mjs";

test("默认跑 spec，--serve 只切换模式且不漏给 Playwright", () => {
  expect(parseRunnerArgs([])).toEqual({ mode: "spec", playwrightArgs: [] });
  expect(parseRunnerArgs(["--serve"])).toEqual({
    mode: "serve",
    playwrightArgs: [],
  });
  expect(parseRunnerArgs(["-g", "device flow"])).toEqual({
    mode: "spec",
    playwrightArgs: ["-g", "device flow"],
  });
  expect(() => parseRunnerArgs(["--dual"])).toThrow(/unknown runner option/);
});

test("每个 run 使用独立保留 IP，让 authorize 限流键可精确清理", () => {
  expect(rateLimitClientIP("run-123")).toMatch(/^198\.18\.\d+\.\d+$/);
  expect(rateLimitClientIP("run-123")).not.toBe(rateLimitClientIP("run-124"));
});

test("fixture CLI 从环境接收 DSN 与 Redis 口令，秘密不进入进程 argv", () => {
  const invocation = seedInvocation(
    "/tmp/webe2e",
    {
      dsn: "u:p@tcp(127.0.0.1:3306)/agentre_e2e",
      redis: { addr: "127.0.0.1:6379", password: "secret", db: 9 },
    },
    "run-123",
  );
  expect(invocation).toEqual({
    command: "/tmp/webe2e",
    args: ["seed", "--redis-db", "9", "--run-id", "run-123"],
    env: {
      WEBE2E_DSN: "u:p@tcp(127.0.0.1:3306)/agentre_e2e",
      WEBE2E_REDIS_ADDR: "127.0.0.1:6379",
      WEBE2E_REDIS_PASSWORD: "secret",
    },
  });
  expect(invocation.args.join(" ")).not.toContain("u:p");
  expect(invocation.args.join(" ")).not.toContain("secret");
});

test("spec 模式使用 task 4 的真实浏览器配置，而不是旧 mock smoke 配置", () => {
  expect(playwrightInvocation(["-g", "device flow"])).toEqual({
    command: "pnpm",
    args: [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.e2e.config.ts",
      "-g",
      "device flow",
    ],
  });
});

test("正式 server 使用显式 E2E 配置启动", () => {
  expect(
    serverInvocation("/repo/bin/server", "/repo/configs/config.e2e.yaml"),
  ).toEqual({
    command: "/repo/bin/server",
    args: ["--config", "/repo/configs/config.e2e.yaml"],
  });
});

test("runtime、日志、handoff 和 cleanup 结果都在 gitignored 本轮目录", () => {
  const paths = runtimePaths("/repo/e2e", "run-123");
  expect(paths.root).toBe("/repo/e2e/runtime/run-123");
  expect(paths.serverLog).toBe("/repo/e2e/runtime/run-123/server.log");
  expect(paths.seed).toBe("/repo/e2e/runtime/run-123/seed.json");
  expect(paths.cleanup).toBe("/repo/e2e/runtime/run-123/cleanup.json");
  expect(paths.handoff).toBe("/repo/e2e/.drive/serve-env.json");
});

test("serve handoff 带齐同源登录和只读 oracle 所需字段", () => {
  const payload = serveEnvPayload({
    serverURL: "http://127.0.0.1:41234",
    cookieName: "server_session",
    sid: "seeded-sid",
    csrfToken: "csrf-secret",
    dsn: "u:p@tcp(127.0.0.1:3306)/agentre_e2e",
    runID: "run-123",
    userID: 42,
    serverLog: "/tmp/run/server.log",
  });
  expect(payload).toMatchObject({
    serverURL: "http://127.0.0.1:41234",
    cookieName: "server_session",
    sid: "seeded-sid",
    csrfToken: "csrf-secret",
    dsn: "u:p@tcp(127.0.0.1:3306)/agentre_e2e",
    runID: "run-123",
    userID: 42,
  });
});

test("缺 sid 或 csrf 的 handoff 当场失败", () => {
  const base = {
    serverURL: "http://127.0.0.1:41234",
    cookieName: "server_session",
    dsn: "u:p@tcp(127.0.0.1:3306)/agentre_e2e",
    runID: "run-123",
    userID: 42,
    serverLog: "/tmp/run/server.log",
  };
  expect(() => serveEnvPayload({ ...base, csrfToken: "csrf" })).toThrow(/sid/);
  expect(() => serveEnvPayload({ ...base, sid: "sid" })).toThrow(/csrf/i);
});

test("失效 handoff 不会被后续 drive 当作可用环境", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-handoff-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "serve-env.json");
  writeFileSync(
    path,
    JSON.stringify({ serverURL: "http://127.0.0.1:1", sid: "old" }),
  );
  await expect(handoffIsLive(path, async () => false)).resolves.toBe(false);
});

test("健康 handoff 仍属于正在运行的 serve，后续启动不得覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-handoff-live-"));
  const path = join(dir, "serve-env.json");
  writeFileSync(
    path,
    JSON.stringify({ serverURL: "http://127.0.0.1:41234", runID: "run-live" }),
  );
  await expect(handoffIsLive(path, async () => true)).resolves.toBe(true);
  expect(() => prepareHandoff(path, true)).toThrow(/still live/i);
  removeOwnedHandoff(path, false);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    runID: "run-live",
  });
});

test("seed 输出尚未交回时仍用本轮 run ID cleanup", () => {
  expect(cleanupRunID("run-active", null)).toBe("run-active");
  expect(cleanupRunID("run-active", { run_id: "run-seeded" })).toBe(
    "run-seeded",
  );
});

test("cleanup residue 任一非零就令运行失败", () => {
  expect(cleanupHasResidue({ users: 0, session: 0 })).toBe(false);
  expect(cleanupHasResidue({ users: 0, session: 1 })).toBe(true);
});

test("serve 收到正常终止信号只执行一次成功 cleanup", async () => {
  const target = new EventEmitter();
  const codes: number[] = [];
  installSignalHandlers(target, "serve", async (code) => codes.push(code));

  target.emit("SIGINT");
  target.emit("SIGTERM");
  await Promise.resolve();

  expect(codes).toEqual([0]);
});
