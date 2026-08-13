import { test, expect } from "@playwright/test";

import {
  parseDSN,
  parseMySQLTarget,
  parseRedis,
  redactedConfigSummary,
  summarizeStartupFailure,
} from "../run.mjs";

const CONFIG = `source: file
db:
  dsn: "server:db-secret@tcp(db.e2e.invalid:3307)/agentre_e2e?parseTime=True"
redis:
  addr: "cache.e2e.invalid:6380"
  password: "redis-secret"
  db: 4
`;

test("带引号的 DSN 与 Redis 配置读成裸值", () => {
  expect(parseDSN(CONFIG)).toBe(
    "server:db-secret@tcp(db.e2e.invalid:3307)/agentre_e2e?parseTime=True",
  );
  expect(parseRedis(CONFIG)).toEqual({
    addr: "cache.e2e.invalid:6380",
    password: "redis-secret",
    db: 4,
  });
});

test("MySQL 目标只暴露 host、port 与 E2E 数据库名", () => {
  expect(parseMySQLTarget(parseDSN(CONFIG))).toEqual({
    host: "db.e2e.invalid",
    port: 3307,
    database: "agentre_e2e",
  });
});

test("配置摘要不泄露数据库或 Redis 凭据", () => {
  const summary = redactedConfigSummary(CONFIG);
  expect(summary).toEqual({
    mysql: "db.e2e.invalid:3307/agentre_e2e",
    redis: "cache.e2e.invalid:6380/4",
  });
  expect(JSON.stringify(summary)).not.toContain("db-secret");
  expect(JSON.stringify(summary)).not.toContain("redis-secret");
  expect(JSON.stringify(summary)).not.toContain("server@");
});

test("启动失败优先报告 server 自己的末条错误，并脱敏 DSN", () => {
  const log =
    `config dsn=server:db-secret@tcp(db.e2e.invalid:3307)/agentre_e2e\n` +
    `fatal migration failed for server:db-secret@tcp(db.e2e.invalid:3307)/agentre_e2e --redis-password redis-secret\n`;
  const summary = summarizeStartupFailure(log);
  expect(summary).toContain("migration failed");
  expect(summary).toContain("db.e2e.invalid:3307/agentre_e2e");
  expect(summary).not.toContain("db-secret");
  expect(summary).not.toContain("server:");
  expect(summary).not.toContain("redis-secret");
});
