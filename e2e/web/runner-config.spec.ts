/**
 * run-e2e-web.mjs 的配置读写与失败诊断(测试接缝 10 的「不可达时明确失败并说出
 * 缺什么」)。不开浏览器、不碰服务器:这里驱动的是 runner 里的几个纯函数。
 *
 * 放在 web/ 是因为它守的就是这条 harness 本身 —— 别人本地跑不起来的三处真实缺陷
 * 都落在这几个函数上:
 *   1. YAML 标量带引号(本仓 configs/config.example.yaml 就是带引号写法)时,
 *      用 (\S+) 捕获会把引号拼进路径 → server 报 missing JWT key;
 *   2. 开发者的 config.yaml 已是 main 的密钥轮换形态(active_kid + keys 列表),
 *      而本分支的 bootstrap.JWTConfig 只认扁平字段 → 两个字段绑定为空;
 *   3. 服务器起不来时 runner 未经探测就断言「PostgreSQL 或 Redis 不可达」,
 *      把读者引向错误的子系统。
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  rewriteServerConfig,
  parseDSN,
  parseRedis,
  summarizeStartupFailure,
} from "../run-e2e-web.mjs";

/** 造一个和真 checkout 同形的目录:configs/ + runtime/keys/ 下的真密钥文件。 */
function fakeCheckout(keys: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "webe2e-cfg-"));
  mkdirSync(join(dir, "runtime", "keys"), { recursive: true });
  for (const name of keys) {
    writeFileSync(join(dir, "runtime", "keys", name), "not-a-real-key\n");
  }
  return dir;
}

/** 从改写后的配置里取某个 key 的值(改写后应当是可直接使用的裸路径)。 */
function scalar(text: string, key: string): string {
  const m = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, "m").exec(text);
  return m ? m[1].trim() : "";
}

const QUOTED_FLAT = `server:
  public_url: "https://server.agentre.dev"
  jwt:
    private_key_pem_path: "./runtime/keys/jwt.key"
    public_key_pem_path:  "./runtime/keys/jwt.pub"
    issuer:   "agentre-server"
`;

// agentre-server main 的 8651f57(JWT 密钥轮换)之后的形态。
const ROTATION = `server:
  public_url: "https://server.agentre.dev"
  jwt:
    active_kid: "k2"
    keys:
      - kid: "k1"
        private_key_pem_path: "./runtime/keys/jwt1.key"
        public_key_pem_path: "./runtime/keys/jwt1.pub"
      - kid: "k2"
        private_key_pem_path: "./runtime/keys/jwt2.key"
        public_key_pem_path: "./runtime/keys/jwt2.pub"
    issuer: "agentre-server"
`;

test("带引号的 JWT 路径改写成真实存在的绝对路径,而不是把引号拼进路径", () => {
  const dir = fakeCheckout(["jwt.key", "jwt.pub"]);

  const out = rewriteServerConfig(QUOTED_FLAT, { serverDir: dir, port: 12345 });

  const priv = scalar(out, "private_key_pem_path");
  const pub = scalar(out, "public_key_pem_path");
  expect(priv).toBe(join(dir, "runtime", "keys", "jwt.key"));
  expect(pub).toBe(join(dir, "runtime", "keys", "jwt.pub"));
  // 决定性证据:server 拿这条路径去读文件,读不到就 missing JWT key。
  expect(existsSync(priv)).toBe(true);
  expect(existsSync(pub)).toBe(true);
});

test("密钥轮换形态摊平成本分支认得的扁平字段,取 active_kid 指名的那一对", () => {
  const dir = fakeCheckout(["jwt1.key", "jwt1.pub", "jwt2.key", "jwt2.pub"]);

  const out = rewriteServerConfig(ROTATION, { serverDir: dir, port: 12345 });

  // 扁平字段必须出现在 jwt: 这一层(bootstrap.JWTConfig 只认这两个字段),
  // 且指向 active_kid=k2 的那一对文件。
  const priv = scalar(out, "private_key_pem_path");
  const pub = scalar(out, "public_key_pem_path");
  expect(priv).toBe(join(dir, "runtime", "keys", "jwt2.key"));
  expect(pub).toBe(join(dir, "runtime", "keys", "jwt2.pub"));
  expect(existsSync(priv)).toBe(true);
  expect(out).toMatch(/^ {4}private_key_pem_path: \//m);
});

test("缺了配置里指名的密钥文件时当场失败并说出缺哪个文件", () => {
  const dir = fakeCheckout([]); // 一个密钥文件都没有

  expect(() =>
    rewriteServerConfig(QUOTED_FLAT, { serverDir: dir, port: 12345 }),
  ).toThrow(/jwt\.key/);
});

test("带引号的 DSN 与 Redis 口令读成裸值", () => {
  const text = `db:
  driver: postgres
  dsn: "postgres://server:server@127.0.0.1:5432/server?sslmode=disable"

redis:
  addr: "127.0.0.1:6379"
  password: ""
  db: 0
`;

  expect(parseDSN(text)).toBe(
    "postgres://server:server@127.0.0.1:5432/server?sslmode=disable",
  );
  expect(parseRedis(text)).toEqual({
    addr: "127.0.0.1:6379",
    password: "",
    db: 0,
  });
});

test("启动失败的诊断取服务器日志自己的最后一条错误,不去猜 PG/Redis", () => {
  const log = `{"level":"info","msg":"config loaded"}
{"level":"info","msg":"database connected"}
{"level":"fatal","msg":"missing JWT key: open \\"./runtime/keys/jwt.key\\": no such file or directory"}
`;

  const decisive = summarizeStartupFailure(log);

  expect(decisive).toContain("missing JWT key");
  expect(summarizeStartupFailure(`{"level":"info","msg":"listening"}\n`)).toBe(
    null,
  );
});
