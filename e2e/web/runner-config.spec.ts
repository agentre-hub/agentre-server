/**
 * run-e2e-web.mjs 的配置读写与失败诊断(测试接缝 10 的「不可达时明确失败并说出
 * 缺什么」)。不开浏览器、不碰服务器:这里驱动的是 runner 里的几个纯函数。
 *
 * 放在 web/ 是因为它守的就是这条 harness 本身 —— 别人本地跑不起来的三处真实缺陷
 * 都落在这几个函数上:
 *   1. YAML 标量带引号(本仓 configs/config.example.yaml 就是带引号写法)时,
 *      用 (\S+) 捕获会把引号拼进路径 → server 报 missing JWT key;
 *   2. 开发者的 config.yaml 已是密钥轮换形态(active_kid + keys 列表),而 bootstrap
 *      在 Keys 非空时**只读列表** —— runner 必须把列表每一项的私钥/公钥路径都改写成
 *      绝对路径,只断言第一个同名字段(或只摊平出一个扁平字段)会形成假绿,
 *      server 仍会死在 missing JWT key;
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

/** 从改写后的配置里解析 `keys:` 列表每一项的 kid 与私钥/公钥路径。 */
function keyList(
  text: string,
): Array<{ kid: string; private: string; public: string }> {
  const out: Array<{ kid: string; private: string; public: string }> = [];
  let cur: { kid: string; private: string; public: string } | null = null;
  for (const line of text.split("\n")) {
    const item = /^[ \\t]*-[ \\t]*kid:[ \\t]*(.*)$/.exec(line);
    if (item) {
      if (cur) out.push(cur);
      cur = { kid: unquote(item[1]), private: "", public: "" };
      continue;
    }
    if (!cur) continue;
    const priv = /^[ \\t]*private_key_pem_path:[ \\t]*(.*)$/.exec(line);
    if (priv) cur.private = priv[1].trim();
    const pub = /^[ \\t]*public_key_pem_path:[ \\t]*(.*)$/.exec(line);
    if (pub) cur.public = pub[1].trim();
  }
  if (cur) out.push(cur);
  return out;
}

/** 去 YAML 标量两端的引号(与 run-e2e-web.mjs 的 unquoteScalar 同规则)。 */
function unquote(v: string): string {
  const s = v.trim();
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1)
    : s;
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

test("轮换形态下 keys 列表每一项的私钥/公钥路径都改写成真实存在的绝对路径,active_kid 不变", () => {
  const dir = fakeCheckout(["jwt1.key", "jwt1.pub", "jwt2.key", "jwt2.pub"]);

  const out = rewriteServerConfig(ROTATION, { serverDir: dir, port: 12345 });

  // 决定性证据必须是 keys 列表项本身:bootstrap 在 Keys 非空时只读列表,
  // 只断言第一个同名字段会形成假绿(server 仍从相对路径读列表 → missing JWT key)。
  const kids = keyList(out);
  expect(kids).toEqual([
    {
      kid: "k1",
      private: join(dir, "runtime", "keys", "jwt1.key"),
      public: join(dir, "runtime", "keys", "jwt1.pub"),
    },
    {
      kid: "k2",
      private: join(dir, "runtime", "keys", "jwt2.key"),
      public: join(dir, "runtime", "keys", "jwt2.pub"),
    },
  ]);
  // 每一条路径都必须真实可读(server 拿它 os.ReadFile,读不到就是 missing JWT key)。
  for (const k of kids) {
    expect(existsSync(k.private)).toBe(true);
    expect(existsSync(k.public)).toBe(true);
  }
  // active_kid 保持指名的那一把,不被改写。
  expect(out).toMatch(/^ {4}active_kid: "k2"$/m);
});

test("缺了配置里指名的密钥文件时当场失败并说出缺哪个文件", () => {
  const dir = fakeCheckout([]); // 一个密钥文件都没有

  expect(() =>
    rewriteServerConfig(QUOTED_FLAT, { serverDir: dir, port: 12345 }),
  ).toThrow(/jwt\.key/);
});

test("轮换形态缺了 keys 列表指名的密钥文件时当场失败并说出缺哪个文件", () => {
  const dir = fakeCheckout(["jwt2.key", "jwt2.pub"]); // active(k2)在,k1 那对文件缺失

  expect(() =>
    rewriteServerConfig(ROTATION, { serverDir: dir, port: 12345 }),
  ).toThrow(/jwt1\.key/);
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
