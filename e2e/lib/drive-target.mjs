// 手工驱动这条轨道的契约:命令行怎么解析、什么地址可以驱动、证据落在哪、
// oracle 能做什么。drive.mjs 与 web/drive-cli.spec.ts 都从这里取。
//
// 形状与桌面端 `agentre/e2e/lib/target.mjs` 对齐 —— 两个仓各自独立、不共享代码,
// 但同一套流程、同一套词汇和同样几条机械护栏。这里的规则是**机械的**,不是靠记的:
//
//  1. **只驱动本次 target 自己的 origin。** 线上地址、同机上别的端口(你正在手调的
//     那套 `make dev`)一律拒绝 —— 驱动错了对象,报告里是看不出来的。
//  2. **oracle 只读。** 一次验证观察状态,不制造状态。
//  3. **证据只落在本场景目录里。** 报告里的相对链接靠的就是这一点。
import { join, resolve, sep } from "node:path";

export class IsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IsolationError";
  }
}

/** 带值的开关。其余以 -- 开头的都是布尔;两张表都没有的当场失败。 */
const VALUE_FLAGS = new Set([
  "base",
  "db",
  "limit",
  "nth",
  "port",
  "scenario",
  "state",
  "timeout",
  "viewport",
]);
const BOOL_FLAGS = new Set(["headed", "full", "fresh", "json"]);

/**
 * 拼错的开关**当场失败**,不被当成布尔悄悄吞掉 —— `--headles` 什么都不做而命令
 * 仍然返回成功,是这一条要挡的。
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (VALUE_FLAGS.has(name)) flags[name] = argv[++i];
    else if (BOOL_FLAGS.has(name)) flags[name] = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { command: positional[0], rest: positional.slice(1), flags };
}

const LOCATOR_KINDS = ["testid", "role", "text", "label", "placeholder"];

/**
 * `testid=x` / `role=…` / `text=…` / `label=…` / `placeholder=…`,其余原样当
 * Playwright 选择器。只认这几个前缀:按 indexOf("=") 切的话,
 * `button[aria-label^='Theme']` 会被切成 kind="button[aria-label",整条就废了。
 */
export function splitLocator(spec) {
  for (const kind of LOCATOR_KINDS) {
    if (spec.startsWith(`${kind}=`)) {
      return { kind, value: spec.slice(kind.length + 1) };
    }
  }
  return { kind: "", value: spec };
}

/** `button[name="Save"]` → 角色 + 可选的无障碍名。 */
export function parseRoleSpec(value) {
  const m = /^([a-z]+)(?:\[name=(?:"([^"]*)"|'([^']*)')\])?$/.exec(value);
  if (!m) {
    throw new Error(
      `bad role locator: ${value} (expected role=button[name="Save"])`,
    );
  }
  return { role: m[1], name: m[2] ?? m[3] };
}

/** 命令行上的目标变成绝对地址。裸词当路径,不当协议。 */
export function resolveTargetURL(target, baseURL) {
  if (/^https?:\/\//i.test(target)) return target;
  if (!baseURL) {
    throw new Error(
      `no baseURL to resolve "${target}" against — pass --base, or start the ` +
        "seeded environment with `pnpm serve`",
    );
  }
  return new URL(target.startsWith("/") ? target : `/${target}`, baseURL).href;
}

/** 除了本次 target 自己的 origin,哪儿都不去。 */
export function assertSanctionedURL(session, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new IsolationError(`not a URL: ${url}`);
  }
  const base = new URL(session.baseURL);
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "http:" || !loopback || parsed.port !== base.port) {
    throw new IsolationError(
      `refusing to drive ${url}: this run's target is only ${session.baseURL}`,
    );
  }
  return parsed.toString();
}

/** 一个场景一个目录。报告、日志、截图、资源各归各位。 */
export function scenarioPaths(scratchRoot, slug) {
  const root = join(scratchRoot, slug);
  return {
    slug,
    root,
    logs: join(root, "logs"),
    screenshots: join(root, "screenshots"),
    resources: join(root, "resources"),
  };
}

/** 截图的落点。只能落在本场景目录里。 */
export function shotPath(scenarioDir, name) {
  const shots = resolve(scenarioDir, "screenshots");
  const file = resolve(shots, name.endsWith(".png") ? name : `${name}.png`);
  if (file !== shots && !file.startsWith(shots + sep)) {
    throw new Error(`"${name}" escapes the scenario directory ${shots}`);
  }
  return file;
}

/**
 * Go 的 MySQL DSN(`user:pass@tcp(host:port)/db?params`)→ mysql 客户端怎么调。
 *
 * 两处非要机械化不可:
 *  - **口令走 MYSQL_PWD,不进 argv。** 放命令行的话,同机上任何人 `ps` 都能看到
 *    整条库口令,而这一路上没有任何东西会报错。
 *  - **按最后一个 `@tcp(` 切,不是第一个 `@`。** 口令里带 @ 或 : 很常见,按第一个
 *    切会把口令截断 —— 连上去的是另一套凭据,或者干脆连不上。
 */
export function mysqlInvocation(dsn, query) {
  const m = /^([^:@]+)(?::(.*))?@tcp\(([^:)]+)(?::(\d+))?\)\/([^?]+)/.exec(dsn);
  if (!m) {
    throw new Error(
      `not a MySQL DSN: ${dsn.replace(/:[^:@]*@/, ":<redacted>@")}`,
    );
  }
  const [, user, password = "", host, port = "3306", db] = m;
  return {
    args: [
      "-h",
      host,
      "-P",
      port,
      "-u",
      user,
      "--batch",
      "--table",
      "-e",
      query,
      db,
    ],
    env: { MYSQL_PWD: password },
  };
}

const READ_ONLY_SQL = /^\s*(select|with|explain|show|describe|desc)\b/i;

/** 验证观察状态,不制造状态。 */
export function assertReadOnlySQL(query) {
  if (!READ_ONLY_SQL.test(query)) {
    throw new Error(
      "only SELECT / WITH / EXPLAIN / SHOW are allowed — the oracle is read-only",
    );
  }
  return query;
}

/**
 * serve 播种的那条浏览器会话 → 一个 Playwright Cookie。
 * domain 取 serve 出来的 host:写死 localhost 不会报错,只是这条 Cookie 不会被
 * 带上,表现成「明明播种了账号却一直跳登录页」。
 */
export function sessionCookie(serveEnv) {
  if (!serveEnv?.sid) {
    throw new Error("serve environment has no sid — re-run `pnpm serve`");
  }
  const url = new URL(serveEnv.serverURL);
  return {
    name: serveEnv.cookieName,
    value: serveEnv.sid,
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
  };
}
