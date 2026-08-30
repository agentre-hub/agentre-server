import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRunnerConfig } from "../run.mjs";

function configFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-config-"));
  mkdirSync(join(dir, "configs"), { recursive: true });
  const path = join(dir, "configs", "config.e2e.yaml");
  writeFileSync(path, text);
  return path;
}

const SAFE_CONFIG = `source: file
http:
  address:
    - "127.0.0.1:8443"
db:
  dsn: "server:secret@tcp(127.0.0.1:3306)/agentre_e2e?parseTime=True"
redis:
  addr: "127.0.0.1:6379"
  password: "redis-secret"
  db: 3
server:
  public_url: "http://127.0.0.1:8443"
  insecure_cookies: true
  webauthn:
    rp_id: "localhost"
    origins:
      - "http://localhost:8443"
`;

test("runner 只接受 source:file 的显式 E2E 配置", () => {
  const path = configFile(SAFE_CONFIG);
  expect(readRunnerConfig(path)).toMatchObject({
    configPath: path,
    database: "agentre_e2e",
  });
  expect(() =>
    readRunnerConfig(
      configFile(SAFE_CONFIG.replaceAll("127.0.0.1:8443", "0.0.0.0:8443")),
    ),
  ).toThrow(/localhost|127\.0\.0\.1/);
  expect(() =>
    readRunnerConfig(
      configFile(SAFE_CONFIG.replace("redis:\n", "redis:\n  extra: true\n")),
    ),
  ).toThrow(/unsupported|extra/);
  expect(() =>
    readRunnerConfig(
      configFile(
        SAFE_CONFIG.replace(
          '    - "127.0.0.1:8443"',
          '    - "127.0.0.1:8443"\n    - "0.0.0.0:8444"',
        ),
      ),
    ),
  ).toThrow(/loopback|localhost|127\.0\.0\.1/);
  expect(() =>
    readRunnerConfig(
      configFile(
        SAFE_CONFIG.replace(
          'public_url: "http://127.0.0.1:8443"',
          'public_url: "https://example.com"',
        ),
      ),
    ),
  ).toThrow(/public_url/);
  expect(() =>
    readRunnerConfig(
      configFile(
        SAFE_CONFIG.replace(
          "insecure_cookies: true",
          "insecure_cookies: false",
        ),
      ),
    ),
  ).toThrow(/insecure_cookies/);

  expect(() =>
    readRunnerConfig(
      configFile(
        SAFE_CONFIG.replace('    rp_id: "localhost"', '    rp_id: "127.0.0.1"'),
      ),
    ),
  ).toThrow(/webauthn.*rp_id/i);
  expect(() =>
    readRunnerConfig(
      configFile(SAFE_CONFIG.replace('      - "http://localhost:8443"', "")),
    ),
  ).toThrow(/webauthn.*origin/i);

  expect(() =>
    readRunnerConfig(
      configFile(SAFE_CONFIG.replace("source: file", "source: etcd")),
    ),
  ).toThrow(/source: file/);
});

test("数据库名必须带 e2e 标识，拒绝普通开发或生产库", () => {
  const path = configFile(SAFE_CONFIG.replace("agentre_e2e", "agentre"));
  expect(() => readRunnerConfig(path)).toThrow(/E2E database/i);
});

test("缺失显式配置时指出路径且不回退", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "e2e-missing-")),
    "configs",
    "config.e2e.yaml",
  );
  expect(() => readRunnerConfig(path)).toThrow(path);
});
