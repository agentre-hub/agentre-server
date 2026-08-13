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

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const defaultConfigPath = join(root, "configs", "config.e2e.yaml");
const serveEnvPath = join(here, ".drive", "serve-env.json");

export function parseRunnerArgs(argv) {
  const playwrightArgs = [];
  let mode = "spec";
  for (const arg of argv) {
    if (arg === "--serve") mode = "serve";
    else if (arg === "--dual" || arg === "--web") {
      throw new Error(
        `unknown runner option ${arg}: agentred/Wails tracks were removed`,
      );
    } else playwrightArgs.push(arg);
  }
  return { mode, playwrightArgs };
}

function unquote(raw) {
  const value = String(raw ?? "").trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function yamlBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^${name}:[ \\t]*$`).test(line),
  );
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() && !/^[ \t]/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

function blockScalar(text, block, key, fallback = "") {
  const body = yamlBlock(text, block);
  if (body === null) return fallback;
  const match = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, "m").exec(body);
  return match ? unquote(match[1]) : fallback;
}

function assertKnownKeys(text, block, allowed) {
  const body = yamlBlock(text, block);
  if (body === null) throw new Error(`config has no ${block} block`);
  for (const line of body.split("\n")) {
    const match = /^  ([a-zA-Z_][a-zA-Z0-9_]*):/.exec(line);
    if (match && !allowed.has(match[1])) {
      throw new Error(`unsupported ${block}.${match[1]} config key`);
    }
  }
}

export function parseDSN(text) {
  return blockScalar(text, "db", "dsn") || null;
}

export function parseRedis(text) {
  return {
    addr: blockScalar(text, "redis", "addr", "127.0.0.1:6379"),
    password: blockScalar(text, "redis", "password"),
    db: Number(blockScalar(text, "redis", "db", "0")),
  };
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

function parseHTTPAddress(text) {
  const body = yamlBlock(text, "http");
  const addresses = [...(body ?? "").matchAll(/^[ \t]*-[ \t]*(.*)$/gm)].map(
    (match) => unquote(match[1]),
  );
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

function sourceIsFile(text) {
  const match = /^source:[ \t]*(.*)$/m.exec(text);
  return match && unquote(match[1]) === "file";
}

function validateBrowserConfig(text, http) {
  const publicURL = blockScalar(text, "server", "public_url");
  const expectedOrigin = `http://${http.host}:${http.port}`;
  if (publicURL !== expectedOrigin) {
    throw new Error(`server.public_url must equal ${expectedOrigin} for E2E`);
  }
  const insecureCookies = blockScalar(text, "server", "insecure_cookies");
  if (insecureCookies !== "true") {
    throw new Error("server.insecure_cookies must be true for loopback E2E");
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
  if (!sourceIsFile(text)) {
    throw new Error(`${path} must declare source: file`);
  }
  const dsn = parseDSN(text);
  if (!dsn) throw new Error(`${path} has no db.dsn`);
  const mysql = parseMySQLTarget(dsn);
  if (!isE2EDatabase(mysql.database)) {
    throw new Error(
      `refusing non-E2E database ${mysql.database}; the database name must contain an E2E marker`,
    );
  }
  assertKnownKeys(
    text,
    "db",
    new Set(["driver", "dsn", "debug", "prepareStmt"]),
  );
  assertKnownKeys(text, "redis", new Set(["addr", "password", "db"]));
  const redis = parseRedis(text);
  if (!redis.addr || !Number.isInteger(redis.db)) {
    throw new Error(`${path} has invalid redis configuration`);
  }
  const http = parseHTTPAddress(text);
  validateBrowserConfig(text, http);
  return {
    configPath: path,
    text,
    dsn,
    mysql,
    database: mysql.database,
    redis,
    http,
  };
}

export function redactedConfigSummary(text) {
  const mysql = parseMySQLTarget(parseDSN(text));
  const redis = parseRedis(text);
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

export function serverInvocation(serverBin, configPath) {
  return { command: serverBin, args: ["--config", configPath] };
}

export function playwrightInvocation(args) {
  return {
    command: "pnpm",
    args: [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.e2e.config.ts",
      ...args,
    ],
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
  return {
    serverURL: values.serverURL,
    cookieName: values.cookieName,
    sid: values.sid,
    csrfToken: values.csrfToken,
    dsn: values.dsn,
    runID: values.runID,
    userID: values.userID,
    serverLog: values.serverLog,
  };
}

export async function handoffIsLive(path, probe = probeHealth) {
  if (!existsSync(path)) return false;
  try {
    const handoff = JSON.parse(readFileSync(path, "utf8"));
    return Boolean(handoff.serverURL && (await probe(handoff.serverURL)));
  } catch {
    return false;
  }
}

export function prepareHandoff(path, live) {
  if (live) throw new Error("another E2E serve environment is still live");
  rmSync(path, { force: true });
}

export function removeOwnedHandoff(path, owned) {
  if (owned) rmSync(path, { force: true });
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
  const result = cleanup(old.runID);
  if (cleanupHasResidue(result.residue)) {
    throw new Error(`stale run ${old.runID} still has isolated residue`);
  }
  rmSync(path, { force: true });
}

export function cleanupRunID(activeRunID, seedResult) {
  return seedResult?.run_id ?? activeRunID ?? null;
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

let serverProc = null;
let config = null;
let paths = null;
let seeded = null;
let activeRunID = null;
let finishing = false;
let toolReady = false;

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

function toolInvocation(command, id) {
  if (command === "seed") return seedInvocation(paths.tool, config, id);
  return {
    command: paths.tool,
    args: [command, "--redis-db", String(config.redis.db), "--run-id", id],
    env: {
      WEBE2E_DSN: config.dsn,
      WEBE2E_REDIS_ADDR: config.redis.addr,
      WEBE2E_REDIS_PASSWORD: config.redis.password,
    },
  };
}

function runTool(command, id) {
  const invocation = toolInvocation(command, id);
  const output = execFileSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: { ...process.env, ...invocation.env },
    timeout: 120_000,
  });
  return JSON.parse(output);
}

async function cleanStaleHandoff() {
  await prepareStaleHandoff(serveEnvPath);
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

async function stopServer() {
  if (!serverProc || serverProc.exitCode !== null) return;
  serverProc.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => serverProc.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
  ]);
  if (serverProc.exitCode === null) serverProc.kill("SIGKILL");
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  removeOwnedHandoff(serveEnvPath, seeded !== null);
  const id = cleanupRunID(activeRunID, seeded);
  if (toolReady && id) {
    try {
      const cleanup = runTool("cleanup", id);
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
  await stopServer();
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
  const invocation = serverInvocation(
    join(root, "bin", "server"),
    config.configPath,
  );
  const logFD = openSync(paths.serverLog, "a", 0o600);
  serverProc = spawn(invocation.command, invocation.args, {
    cwd: root,
    stdio: ["ignore", logFD, logFD],
  });

  try {
    await waitForHealth(baseURL);
  } catch (error) {
    throw new Error(startupDetail(error));
  }

  seeded = runTool("seed", activeRunID);
  writePrivateJSON(paths.seed, seeded);
  const configuredCookieName =
    unquote(/^[ \t]*cookie_name:[ \t]*(.*)$/m.exec(config.text)?.[1]) ||
    "server_session";
  const handoff = serveEnvPayload({
    serverURL: baseURL,
    cookieName: configuredCookieName,
    sid: seeded.session.sid,
    csrfToken: seeded.session.csrf_token,
    dsn: config.dsn,
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

  const playwright = playwrightInvocation(playwrightArgs);
  const child = spawn(playwright.command, playwright.args, {
    cwd: here,
    env: process.env,
    stdio: "inherit",
  });
  child.once("exit", (code) => void finish(code ?? 1));
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
