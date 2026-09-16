// 精简的真实 E2E runner：构建并启动正式 server，等待真实 healthz，创建一轮隔离
// fixture，然后运行 committed spec 或为 `pnpm drive` 保持环境。它不启动 Vite、
// agentred 或 Wails；所有运行期秘密与证据都留在 gitignored 的本轮目录。
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const defaultConfigPath = join(root, "configs", "config.e2e.yaml");
const serveEnvPath = join(here, ".drive", "serve-env.json");

export function parseRunnerArgs(argv) {
  const playwrightArgs = [];
  let mode = "spec";
  for (const arg of argv) {
    if (arg === "--serve") mode = "serve";
    else playwrightArgs.push(arg);
  }
  return { mode, playwrightArgs };
}

/**
 * e2e 配置只走 `source: file` 这一条路，且只认少量已知标量块。用真 YAML 解析器
 * 替掉手写子集，是为了不再维护一遍缩进与引号规则；校验层保持原来的白名单与逐值
 * 断言，解析器多出来的 YAML 特性不会顺带放宽 runner 接受什么。
 */
function configMapping(text, label) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new Error(`cannot parse ${label} as YAML: ${error.message}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${label} must be a YAML mapping`);
  }
  return doc;
}

function scalar(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function scalarList(value) {
  return Array.isArray(value) ? value.map((item) => scalar(item)) : [];
}

function dsnFromConfig(config) {
  return scalar(config.db?.dsn) || null;
}

function redisFromConfig(config) {
  return {
    addr: scalar(config.redis?.addr, "127.0.0.1:6379"),
    password: scalar(config.redis?.password),
    db: Number(scalar(config.redis?.db, "0")),
  };
}

function assertKnownKeys(config, block, allowed) {
  const value = config[block];
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`config has no ${block} block`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`unsupported ${block}.${key} config key`);
    }
  }
}

export function parseDSN(text) {
  return dsnFromConfig(configMapping(text, "E2E config"));
}

export function parseRedis(text) {
  return redisFromConfig(configMapping(text, "E2E config"));
}

export function parseMySQLTarget(dsn) {
  const match = /@tcp\(([^():]+|\[[^\]]+\]):(\d+)\)\/([^?\s]+)/.exec(dsn ?? "");
  if (!match) throw new Error("db.dsn must be a Go MySQL tcp DSN");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("db.dsn has an invalid MySQL port");
  }
  return {
    host: match[1].replace(/^\[|\]$/g, ""),
    port,
    database: match[3],
  };
}

function parseHTTPAddress(config) {
  const addresses = scalarList(config.http?.address);
  if (addresses.length !== 1) {
    throw new Error(
      "http.address must contain exactly one loopback E2E address",
    );
  }
  const parsed = /^(localhost|127\.0\.0\.1):(\d+)$/.exec(addresses[0]);
  if (!parsed) {
    throw new Error("http.address must use localhost or 127.0.0.1 for E2E");
  }
  return { host: "127.0.0.1", port: Number(parsed[2]) };
}

function sourceIsFile(config) {
  return scalar(config.source) === "file";
}

function validateBrowserConfig(config, http) {
  const publicURL = scalar(config.server?.public_url);
  const expectedOrigin = `http://${http.host}:${http.port}`;
  if (publicURL !== expectedOrigin) {
    throw new Error(`server.public_url must equal ${expectedOrigin} for E2E`);
  }
  const insecureCookies = scalar(config.server?.insecure_cookies);
  if (insecureCookies !== "true") {
    throw new Error("server.insecure_cookies must be true for loopback E2E");
  }
  const rpID = scalar(config.server?.webauthn?.rp_id);
  if (rpID !== "localhost") {
    throw new Error("server.webauthn.rp_id must equal localhost for E2E");
  }
  const passkeyOrigin = `http://localhost:${http.port}`;
  if (!scalarList(config.server?.webauthn?.origins).includes(passkeyOrigin)) {
    throw new Error(
      `server.webauthn.origins must include ${passkeyOrigin} for E2E`,
    );
  }
}

function isE2EDatabase(name) {
  return /(^|[_-])e2e($|[_-])/i.test(name);
}

export function readRunnerConfig(configPath = defaultConfigPath) {
  const path = resolve(configPath);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read explicit E2E config ${path}: ${error.message}`,
    );
  }
  const config = configMapping(text, path);
  if (!sourceIsFile(config)) {
    throw new Error(`${path} must declare source: file`);
  }
  const dsn = dsnFromConfig(config);
  if (!dsn) throw new Error(`${path} has no db.dsn`);
  const mysql = parseMySQLTarget(dsn);
  if (!isE2EDatabase(mysql.database)) {
    throw new Error(
      `refusing non-E2E database ${mysql.database}; the database name must contain an E2E marker`,
    );
  }
  assertKnownKeys(
    config,
    "db",
    new Set(["driver", "dsn", "debug", "prepareStmt"]),
  );
  assertKnownKeys(config, "redis", new Set(["addr", "password", "db"]));
  const redis = redisFromConfig(config);
  if (!redis.addr || !Number.isInteger(redis.db)) {
    throw new Error(`${path} has invalid redis configuration`);
  }
  const http = parseHTTPAddress(config);
  validateBrowserConfig(config, http);
  return {
    configPath: path,
    text,
    dsn,
    mysql,
    database: mysql.database,
    redis,
    http,
    cookieName: scalar(config.cookie_name) || "server_session",
  };
}

export function redactedConfigSummary(text) {
  const config = configMapping(text, "E2E config");
  const mysql = parseMySQLTarget(dsnFromConfig(config));
  const redis = redisFromConfig(config);
  return {
    mysql: `${mysql.host}:${mysql.port}/${mysql.database}`,
    redis: `${redis.addr}/${redis.db}`,
  };
}

function redactSensitive(text) {
  return String(text ?? "")
    .replace(/[^\s"']+@tcp\(([^)]+)\)\/([^?\s"']+)(?:\?[^\s"']*)?/g, "$1/$2")
    .replace(
      /((?:--)?(?:redis-)?password(?:[=:]|[ \t])+)([^\s,;]+)/gi,
      "$1<redacted>",
    );
}

export function summarizeStartupFailure(logText) {
  const lines = String(logText ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (
      /error|fatal|panic|missing|refused|denied|timeout|no such file/i.test(
        lines[i],
      )
    ) {
      return redactSensitive(lines[i].trim());
    }
  }
  return null;
}

export function runtimePaths(e2eDir, runID) {
  if (!/^[a-zA-Z0-9_-]+$/.test(runID)) throw new Error("invalid run ID");
  const runtimeRoot = join(e2eDir, "runtime", runID);
  return {
    root: runtimeRoot,
    serverLog: join(runtimeRoot, "server.log"),
    seed: join(runtimeRoot, "seed.json"),
    cleanup: join(runtimeRoot, "cleanup.json"),
    tool: join(runtimeRoot, "webe2e"),
    handoff: join(e2eDir, ".drive", "serve-env.json"),
  };
}

export function rateLimitClientIP(id) {
  const bytes = createHash("sha256").update(id).digest();
  return `198.18.${bytes[0]}.${bytes[1]}`;
}

export function seedInvocation(tool, runnerConfig, id) {
  return {
    command: tool,
    args: ["seed", "--redis-db", String(runnerConfig.redis.db), "--run-id", id],
    env: {
      WEBE2E_DSN: runnerConfig.dsn,
      WEBE2E_REDIS_ADDR: runnerConfig.redis.addr,
      WEBE2E_REDIS_PASSWORD: runnerConfig.redis.password,
    },
  };
}

export function serveEnvPayload(values) {
  for (const key of [
    "serverURL",
    "cookieName",
    "sid",
    "csrfToken",
    "dsn",
    "redis",
    "runID",
    "userID",
    "serverLog",
  ]) {
    if (
      values[key] === undefined ||
      values[key] === null ||
      values[key] === ""
    ) {
      throw new Error(`serve handoff is missing ${key}`);
    }
  }
  return values;
}

export async function cleanupThenRemoveHandoff(path, owned, cleanup) {
  const result = await cleanup();
  if (owned && !cleanupHasResidue(result?.residue)) {
    rmSync(path, { force: true });
  }
  return result;
}

export async function prepareStaleHandoff(
  path,
  probe = probeHealth,
  cleanup = (id) => runTool("cleanup", id),
) {
  if (!existsSync(path)) return;
  let old;
  try {
    old = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `malformed E2E handoff ${path}; manual inspection is required`,
    );
  }
  if (old?.serverURL && (await probe(old.serverURL))) {
    throw new Error("another E2E serve environment is still live");
  }
  if (!old?.runID || !/^[a-zA-Z0-9_-]+$/.test(old.runID)) {
    throw new Error(
      `E2E handoff ${path} has no owned run ID; manual inspection is required`,
    );
  }
  const result = cleanup(old);
  if (cleanupHasResidue(result.residue)) {
    throw new Error(`stale run ${old.runID} still has isolated residue`);
  }
  rmSync(path, { force: true });
}

export function cleanupHasResidue(residue) {
  return Object.values(residue ?? {}).some((count) => Number(count) > 0);
}

export function installSignalHandlers(target, mode, finish) {
  let handled = false;
  const handler = () => {
    if (handled) return;
    handled = true;
    void finish(mode === "serve" ? 0 : 1);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) target.on(signal, handler);
  return handler;
}

export function installChildCompletion(child, finish) {
  let handled = false;
  const complete = (code) => {
    if (handled) return;
    handled = true;
    void finish(code);
  };
  child.once("error", () => complete(1));
  child.once("exit", (code) => complete(code ?? 1));
}

export async function stopManagedChild(child, timeout = 5000) {
  if (!child || !child.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, timeout)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let serverProc = null;
let playwrightProc = null;
let config = null;
let paths = null;
let seeded = null;
let activeRunID = null;
let finishing = false;
let toolReady = false;
let serverStartError = null;

function runID() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writePrivateJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function build(pathsForRun) {
  execFileSync("make", ["build"], { cwd: root, stdio: "inherit" });
  execFileSync("go", ["build", "-o", pathsForRun.tool, "./e2e/webe2e"], {
    cwd: root,
    env: { ...process.env, GOWORK: "off" },
    stdio: "inherit",
  });
}

function toolInvocation(command, id, overrides = {}) {
  const tool = overrides.tool ?? paths.tool;
  const dsn = overrides.dsn ?? config.dsn;
  const redis = overrides.redis ?? config.redis;
  if (command === "seed") return seedInvocation(tool, { dsn, redis }, id);
  return {
    command: tool,
    args: [command, "--redis-db", String(redis.db), "--run-id", id],
    env: {
      WEBE2E_DSN: dsn,
      WEBE2E_REDIS_ADDR: redis.addr,
      WEBE2E_REDIS_PASSWORD: redis.password,
    },
  };
}

export function decodeToolResult(output, error = null) {
  if (String(output ?? "").trim()) return JSON.parse(output);
  if (error) throw error;
  throw new Error("fixture tool produced no JSON output");
}

/**
 * 跑一次 fixture CLI。overrides 用来替掉那轮 run 的 tool / dsn / redis（孤儿 cleanup
 * 用的是旧 handoff 里的依赖，不是本轮的 config）；execute 是测试的注入缝。
 */
export function runTool(command, id, overrides = {}, execute = execFileSync) {
  const invocation = toolInvocation(command, id, overrides);
  try {
    const output = execute(invocation.command, invocation.args, {
      encoding: "utf8",
      env: { ...process.env, ...invocation.env },
      timeout: 120_000,
    });
    return decodeToolResult(output);
  } catch (error) {
    return decodeToolResult(error.stdout, error);
  }
}

async function cleanStaleHandoff() {
  await prepareStaleHandoff(serveEnvPath, probeHealth, (old) =>
    runTool("cleanup", old.runID, { dsn: old.dsn, redis: old.redis }),
  );
}

async function probeHealth(baseURL) {
  if (!baseURL) return false;
  try {
    const response = await fetch(`${baseURL}/v1/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    const health = body.data ?? body;
    return (
      health.status === "ok" && health.db_ping === true && health.redis === true
    );
  } catch {
    return false;
  }
}

async function waitForHealth(baseURL) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (serverStartError) {
      throw new Error(
        `server process failed to start: ${serverStartError.message}`,
      );
    }
    if (serverProc?.exitCode !== null) {
      throw new Error(
        `server exited during startup with code ${serverProc.exitCode}`,
      );
    }
    if (await probeHealth(baseURL)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `server did not reach healthy DB/Redis state at ${baseURL}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

function startupDetail(error) {
  let log = "";
  try {
    log = readFileSync(paths.serverLog, "utf8");
  } catch {
    // server may fail before producing output
  }
  const decisive = summarizeStartupFailure(log);
  return [
    error.message,
    decisive ? `server error: ${decisive}` : null,
    `server log: ${paths.serverLog}`,
    `runtime: ${paths.root}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  await stopManagedChild(playwrightProc);
  const id = seeded?.run_id ?? activeRunID ?? null;
  if (toolReady && id) {
    try {
      const cleanup = await cleanupThenRemoveHandoff(
        serveEnvPath,
        seeded !== null,
        async () => runTool("cleanup", id),
      );
      writePrivateJSON(paths.cleanup, cleanup);
      const residue = Object.entries(cleanup.residue ?? {}).filter(
        ([, count]) => count > 0,
      );
      console.log(
        `[e2e] cleanup ${JSON.stringify(cleanup.deleted ?? {})}${
          residue.length
            ? `; residue ${JSON.stringify(residue)}`
            : "; no residue"
        }`,
      );
      if (cleanupHasResidue(cleanup.residue)) code = code || 1;
    } catch (error) {
      console.error(
        `[e2e] cleanup failed for run ${id}: ${redactSensitive(error.message)}`,
      );
      code = code || 1;
    }
  }
  await stopManagedChild(serverProc);
  process.exit(code);
}

async function main() {
  const { mode, playwrightArgs } = parseRunnerArgs(process.argv.slice(2));
  config = readRunnerConfig(process.env.E2E_CONFIG ?? defaultConfigPath);
  activeRunID = runID();
  paths = runtimePaths(here, activeRunID);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.handoff), { recursive: true, mode: 0o700 });

  const summary = redactedConfigSummary(config.text);
  console.log(`[e2e] target MySQL ${summary.mysql}; Redis ${summary.redis}`);
  console.log("[e2e] building frontend, formal server, and fixture tool …");
  build(paths);
  toolReady = true;
  await cleanStaleHandoff();

  const baseURL = `http://${config.http.host}:${config.http.port}`;
  if (await portIsBusy(config.http.port)) {
    throw new Error(
      `E2E port ${config.http.port} is already in use; refusing to reuse another server`,
    );
  }
  const logFD = openSync(paths.serverLog, "a", 0o600);
  serverProc = spawn(
    join(root, "bin", "server"),
    ["--config", config.configPath],
    {
      cwd: root,
      stdio: ["ignore", logFD, logFD],
    },
  );
  serverProc.once("error", (error) => {
    serverStartError = error;
  });

  try {
    await waitForHealth(baseURL);
  } catch (error) {
    throw new Error(startupDetail(error));
  }

  seeded = runTool("seed", activeRunID);
  writePrivateJSON(paths.seed, seeded);
  const configuredCookieName = config.cookieName;
  const handoff = serveEnvPayload({
    serverURL: baseURL,
    cookieName: configuredCookieName,
    sid: seeded.session.sid,
    csrfToken: seeded.session.csrf_token,
    dsn: config.dsn,
    redis: config.redis,
    runID: seeded.run_id,
    userID: seeded.user_id,
    serverLog: paths.serverLog,
  });
  writePrivateJSON(paths.handoff, handoff);

  Object.assign(process.env, {
    E2E_BASE_URL: baseURL,
    E2E_RUNTIME_DIR: paths.root,
    E2E_HANDOFF_PATH: paths.handoff,
    E2E_RUN_ID: seeded.run_id,
    E2E_RATE_LIMIT_IP: rateLimitClientIP(seeded.run_id),
  });
  installSignalHandlers(process, mode, finish);

  if (mode === "serve") {
    console.log(
      `[e2e] serve ready at ${baseURL}\n` +
        `  handoff: ${paths.handoff}\n` +
        `  runtime: ${paths.root}\n` +
        "  next: cd e2e && pnpm drive up\n" +
        "  Ctrl-C stops the server and cleans this run",
    );
    await new Promise(() => {});
    return;
  }

  playwrightProc = spawn(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.e2e.config.ts",
      ...playwrightArgs,
    ],
    {
      cwd: here,
      env: process.env,
      stdio: "inherit",
    },
  );
  installChildCompletion(playwrightProc, finish);
}

function portIsBusy(port) {
  return new Promise((resolvePromise) => {
    const server = createTcpServer();
    server.once("error", () => resolvePromise(true));
    server.listen(port, "127.0.0.1", () =>
      server.close(() => resolvePromise(false)),
    );
  });
}

const isEntrypoint =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(async (error) => {
    console.error(`[e2e] ${redactSensitive(error.message)}`);
    await finish(1);
  });
}
