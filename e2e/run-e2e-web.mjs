// Runner for the WEB FULL-CHAIN end-to-end suite (e2e/web/) — the one harness
// that needs everything real: a real browser + the real agentre-server + a real
// agentred daemon. Spec: docs/specs/2026-08-10-web-session-access.md 测试接缝 10.
//
// Everything stateful lives here rather than in playwright.config.ts, because the
// config is re-evaluated in every worker while all of this must happen exactly
// once, before the browser boots:
//
//   1. locate the agentre-server and agentre checkouts, read the developer's DSN + Redis
//   2. build the server + the `webe2e` harness tool (GOWORK=off) + agentred (-tags e2e)
//   3. start the server on a free port against the developer's PostgreSQL + Redis
//   4. seed ONE throwaway account + one agentred device + one Redis browser session
//   5. trade the agentred refresh token for a real access JWT, write a claimed
//      agentred state.json, and run the real agentred daemon against the server
//   6. wait until the agentred is online on the relay
//   7. seed the agentred.db session + journal rows (node:sqlite oracle)
//   8. run playwright with the harness env exported
//   9. ALWAYS delete exactly the rows this run seeded, then kill agentred + server
//
// It is NOT in CI and not part of make test. It depends on the developer's
// database; when that is unreachable the runner fails with a message naming what
// is missing — it never skips and never reports a pass it did not get.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // e2e/
const serverRoot = join(here, ".."); // agentre-server checkout (this worktree)
const runID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const workDir = join(tmpdir(), `aw${runID}`);
const serverLog = join(workDir, "server.log");
const agentredLog = join(workDir, "agentred.log");
const agentredDataDir = join(workDir, "ad");
const agentredDB = join(agentredDataDir, "agentred.db");
const webserverLog = join(workDir, "webserver.log");

// The browser's fixed device fingerprint. It must match the peer fingerprint the
// harness seeds the agentred.db session with, so the browser OWNS that session.
const WEB_FINGERPRINT = "e2e-web-fingerprint-0001";

let serverProc = null;
let agentredProc = null;
let toolBin = "";
let dsn = "";
let redis = { addr: "", password: "", db: 0 };
let seeded = null;
let serverURL = "";

main().catch((err) => {
  console.error(`\n[web-e2e] ${err.message}\n`);
  void finish(1);
});

async function main() {
  const serverDir = resolve(serverRoot);
  const agentreDir = locateAgentreCheckout(serverDir);
  // The worktree's configs/ only has config.example.yaml (the real DSN is
  // gitignored); the developer's real config.yaml lives in the main checkout.
  const configCheckout = existsSync(join(serverDir, "configs", "config.yaml"))
    ? serverDir
    : mainCheckout(serverDir);
  dsn = readDSN(configCheckout);
  redis = readRedis(configCheckout);

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(agentredDataDir, { recursive: true, mode: 0o700 });

  console.log("[web-e2e] building frontend + server + webe2e + agentred …");
  if (process.env.WEBE2E_SKIP_FRONTEND_BUILD !== "1") {
    buildFrontend(serverDir);
  } else {
    console.log(
      "[web-e2e] WEBE2E_SKIP_FRONTEND_BUILD=1 → reusing frontend/dist",
    );
  }
  copyDist(serverDir);
  const serverBin = join(workDir, "agentre-server");
  toolBin = join(workDir, "webe2e");
  goBuild(serverDir, serverBin, "./cmd/server");
  goBuild(serverDir, toolBin, "./e2e/webe2e");
  const agentredBin = join(workDir, "agentred");
  goBuild(agentreDir, agentredBin, "./cmd/agentred", ["-tags", "e2e"]);

  const serverPort = await freePort();
  serverURL = `http://127.0.0.1:${serverPort}`;
  const serverCwd = writeServerConfig(configCheckout, serverPort, workDir);
  console.log(`[web-e2e] starting agentre-server on ${serverURL} …`);
  serverProc = spawn(serverBin, [], {
    cwd: serverCwd,
    stdio: ["ignore", openLog(serverLog), openLog(serverLog)],
  });
  serverProc.on("exit", (code) => {
    if (code !== null && code !== 0)
      console.error(`[web-e2e] server exited with ${code}`);
  });
  await waitForServer(serverURL);

  console.log(`[web-e2e] seeding account webe2e-${runID} …`);
  const daemonUUID = randomUUID().replace(/-/g, "");
  const agentredFP = daemonFingerprint(daemonUUID);
  seeded = runTool([
    "seed",
    "--dsn",
    dsn,
    "--redis-addr",
    redis.addr,
    "--redis-password",
    redis.password,
    "--redis-db",
    String(redis.db),
    "--run-id",
    runID,
    "--agentred-fingerprint",
    agentredFP,
  ]);

  // Trade the seeded refresh token for a real access JWT over real HTTP, then
  // write a claimed state.json (mirror of what `agentred login` leaves behind).
  const token = await refreshToken(serverURL, seeded.agentred.refresh_token);
  const publicKey = await fetchServerPublicKey(serverURL);
  writeAgentredState(agentredDataDir, {
    daemonUUID,
    accountId: String(seeded.user_id),
    deviceId: seeded.agentred.device_id,
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt: Date.now() + token.refresh_expires_in * 1000,
    accessToken: token.access_token,
    accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
    publicKeyPEM: publicKey,
  });

  console.log(`[web-e2e] starting agentred (${agentredFP}) …`);
  agentredProc = spawn(agentredBin, ["run", "--server", serverURL], {
    cwd: workDir,
    env: { ...process.env, AGENTRED_DATA_DIR: agentredDataDir },
    stdio: ["ignore", openLog(agentredLog), openLog(agentredLog)],
  });
  agentredProc.on("exit", (code) => {
    if (code !== null && code !== 0)
      console.error(`[web-e2e] agentred exited with ${code}`);
  });
  await waitForAgentredOnline(serverURL, agentredFP, seeded.user_id);

  console.log("[web-e2e] seeding agentred.db session + journal …");
  seedAgentredSession(agentredDB, agentredFP);

  Object.assign(process.env, {
    WEBE2E_SERVER_URL: serverURL,
    WEBE2E_RUN_ID: runID,
    WEBE2E_SESSION_SID: seeded.session.sid,
    WEBE2E_COOKIE_NAME: "server_session",
    WEBE2E_WEB_FINGERPRINT: WEB_FINGERPRINT,
    WEBE2E_AGENTRED_DB: agentredDB,
    WEBE2E_AGENTRED_DATA_DIR: agentredDataDir,
    WEBE2E_AGENTRED_FINGERPRINT: agentredFP,
    WEBE2E_AGENTRED_LOG: agentredLog,
    WEBE2E_SERVER_LOG: serverLog,
  });

  const require = createRequire(import.meta.url);
  const playwrightCli = require.resolve("@playwright/test/cli");
  const child = spawn(
    process.execPath,
    [
      playwrightCli,
      "test",
      "--config",
      "playwright.web.config.ts",
      ...process.argv.slice(2),
    ],
    { cwd: here, stdio: "inherit" },
  );
  child.on("exit", (code) => void finish(code ?? 1));
}

// ── teardown ────────────────────────────────────────────────────────────────

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;

  if (toolBin && dsn && seeded) {
    // Cleanup runs on every exit path, including a crashed suite: this database is
    // shared with the developer's other work, so leaving rows behind is not an option.
    try {
      const res = runTool([
        "cleanup",
        "--dsn",
        dsn,
        "--redis-addr",
        redis.addr,
        "--redis-password",
        redis.password,
        "--redis-db",
        String(redis.db),
        "--run-id",
        runID,
      ]);
      const residue = Object.entries(res.residue ?? {}).filter(
        ([, n]) => n > 0,
      );
      console.log(
        `[web-e2e] cleaned up account ${res.user_id}: ` +
          `${JSON.stringify(res.deleted)}${residue.length ? ` RESIDUE ${JSON.stringify(residue)}` : " (no residue)"}`,
      );
      if (residue.length) code = code || 1;
    } catch (err) {
      console.error(
        `[web-e2e] CLEANUP FAILED — rows may remain for run ${runID}: ${err.message}`,
      );
      code = code || 1;
    }
  }

  if (agentredProc && agentredProc.exitCode === null)
    agentredProc.kill("SIGTERM");
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGTERM");

  if (code === 0) {
    rmSync(workDir, { recursive: true, force: true });
  } else {
    console.log(
      `[web-e2e] kept ${workDir} for inspection (server.log, agentred.log, agentred.db, screenshots)`,
    );
  }
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void finish(1));

// ── pieces ──────────────────────────────────────────────────────────────────

function daemonFingerprint(instanceUUID) {
  return `sha256:${createHash("sha256").update(instanceUUID).digest("hex")}`;
}

function locateAgentreCheckout(serverDir) {
  const override = process.env.AGENTRE_DIR;
  if (override) {
    if (existsSync(join(override, "cmd", "agentred"))) return resolve(override);
    throw new Error(`AGENTRE_DIR=${override} has no cmd/agentred`);
  }
  // The sibling agentre repo sits next to agentre-server in the workspace root.
  const workspaceRoot = dirname(dirname(dirname(dirname(serverDir)))); // …/agentre-server/.dev-kit/worktrees/<name> → …/Code/agentre
  const agentreMain = join(workspaceRoot, "agentre");
  // Prefer the agentre worktree with the same name as this one (it carries this
  // branch's cmd/agentred + fake runtime changes), then the agentre main checkout.
  const thisWorktreeName = basename(serverDir);
  const worktreeCandidates = [
    join(agentreMain, ".dev-kit", "worktrees", thisWorktreeName),
    agentreMain,
  ];
  for (const candidate of worktreeCandidates) {
    if (
      existsSync(join(candidate, "go.mod")) &&
      existsSync(join(candidate, "cmd", "agentred"))
    ) {
      return resolve(candidate);
    }
  }
  throw new Error(
    "cannot find the agentre checkout (looked for a sibling 'agentre' with cmd/agentred). " +
      "Set AGENTRE_DIR to point at it.",
  );
}

// mainCheckout 从 worktree 反推主 checkout:worktree 的 .git 是 `gitdir: …` 文件,
// 真正的 .git 目录(含 worktrees/)在 repo 根。找不到就回退到自身(非 worktree 场景)。
function mainCheckout(dir) {
  let d = dir;
  for (let i = 0; i < 10; i++) {
    const gitPath = join(d, ".git");
    try {
      if (existsSync(join(gitPath, "worktrees"))) return d;
    } catch {
      // not a real .git dir
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return dir;
}

function readDSN(serverDir) {
  const configPath = join(serverDir, "configs", "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(
      `${configPath} is missing — the suite needs the server's real DSN.`,
    );
  }
  const match = /^\s*dsn:\s*(\S+)\s*$/m.exec(readFileSync(configPath, "utf8"));
  if (!match) throw new Error(`no db.dsn found in ${configPath}`);
  return match[1];
}

function readRedis(serverDir) {
  const configPath = join(serverDir, "configs", "config.yaml");
  const text = readFileSync(configPath, "utf8");
  const addr = /^\s*addr:\s*(\S+)\s*$/m.exec(text)?.[1] ?? "127.0.0.1:6379";
  const password = /^\s*password:\s*(\S+)\s*$/m.exec(text)?.[1] ?? "";
  const db = Number(/^\s*db:\s*(\S+)\s*$/m.exec(text)?.[1] ?? "0");
  return { addr, password, db };
}

function buildFrontend(serverDir) {
  try {
    execFileSync("pnpm", ["build"], {
      cwd: join(serverDir, "frontend"),
      stdio: "inherit",
    });
  } catch {
    throw new Error("frontend pnpm build failed — see output above");
  }
}

function copyDist(serverDir) {
  const src = join(serverDir, "frontend", "dist");
  const dst = join(serverDir, "internal", "web", "dist");
  if (!existsSync(join(src, "index.html"))) {
    throw new Error(
      `${join(src, "index.html")} missing — frontend build did not produce a bundle`,
    );
  }
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  execFileSync("cp", ["-R", `${src}/.`, dst]);
}

function writeServerConfig(serverDir, port, workDir) {
  const cwd = join(workDir, "server");
  mkdirSync(join(cwd, "configs"), { recursive: true });
  let text = readFileSync(join(serverDir, "configs", "config.yaml"), "utf8");
  text = text.replace(
    /(http:\s*\n\s*address:\s*\n\s*-\s*)(\S+)/,
    `$1127.0.0.1:${port}`,
  );
  // The browser reaches the SPA through the server itself, so the device-flow
  // verification URI (public_url + /device) must point at the server's own URL.
  text = text.replace(/(public_url:\s*)(\S+)/, `$1http://127.0.0.1:${port}`);
  text = text.replace(
    /(private_key_pem_path:\s*)(\S+)/,
    (_m, key, value) => key + resolve(serverDir, value),
  );
  text = text.replace(
    /(public_key_pem_path:\s*)(\S+)/,
    (_m, key, value) => key + resolve(serverDir, value),
  );
  writeFileSync(join(cwd, "configs", "config.yaml"), text);
  return cwd;
}

function goBuild(dir, out, pkg, extraArgs = []) {
  try {
    execFileSync("go", ["build", "-o", out, ...extraArgs, pkg], {
      cwd: dir,
      env: { ...process.env, GOWORK: "off" },
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    throw new Error(`go build ${pkg} failed in ${dir}`);
  }
}

function openLog(path) {
  return openSync(path, "a");
}

async function waitForServer(baseURL) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (serverProc.exitCode !== null) {
      throw new Error(
        `agentre-server exited during startup (code ${serverProc.exitCode}). ` +
          `Most likely PostgreSQL or Redis from configs/config.yaml is unreachable. See ${serverLog}`,
      );
    }
    try {
      const status = await probe(`${baseURL}/v1/keys`);
      if (status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `agentre-server never became healthy on ${baseURL}. ` +
          `Check that PostgreSQL and Redis from agentre-server/configs/config.yaml are reachable. See ${serverLog}`,
      );
    }
    await sleep(500);
  }
}

async function waitForAgentredOnline(baseURL, fp, userID) {
  const deadline = Date.now() + 60_000;
  const cookieName = "server_session";
  const cookie = `${cookieName}=${seeded.session.sid}`;
  for (;;) {
    if (agentredProc.exitCode !== null) {
      throw new Error(
        `agentred exited during startup (code ${agentredProc.exitCode}). ` +
          `The daemon needs a valid claimed state.json + reachable relay. See ${agentredLog}`,
      );
    }
    try {
      const res = await fetchJSON(`${baseURL}/v1/devices`, { cookie });
      if (res.devices?.some((d) => d.fingerprint === fp && d.online === true)) {
        console.log(
          `[web-e2e] agentred online on the relay (device ${userID}/${fp})`,
        );
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `agentred never came online on the relay within 60s (fingerprint ${fp}). ` +
          `See ${agentredLog} and ${serverLog}`,
      );
    }
    await sleep(1000);
  }
}

function serverDirConfigsCookiePath() {
  // placeholder replaced by cookie name from config
  return "";
}

// refreshToken exchanges a refresh token for a fresh access JWT through the real
// POST /v1/oauth/token/refresh (mirrors what the daemon's credential refresher does).
async function refreshToken(baseURL, refreshToken) {
  const res = await fetchJSON(`${baseURL}/v1/oauth/token/refresh`, {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.access_token)
    throw new Error(
      `refresh endpoint returned no access_token: ${JSON.stringify(res)}`,
    );
  return res;
}

// fetchServerPublicKey gets the server's RS256 public key (GET /v1/keys) — the
// daemon's cached verification key for auth.account.
async function fetchServerPublicKey(baseURL) {
  const res = await fetchJSON(`${baseURL}/v1/keys`);
  if (!res.public_key)
    throw new Error(`/v1/keys returned no public_key: ${JSON.stringify(res)}`);
  return res.public_key;
}

function writeAgentredState(dir, s) {
  const state = {
    schemaVersion: 1,
    daemonInstanceUUID: s.daemonUUID,
    listen: { lanHost: "0.0.0.0", lanPort: 0, tlsCertFile: "", tlsKeyFile: "" },
    pairedPeers: {},
    llmProviders: {},
    preferences: {
      logLevel: "info",
      logRotateMB: 50,
      pairingCodeTTLSeconds: 300,
    },
    accountId: s.accountId,
    verificationPublicKeyPEM: s.publicKeyPEM,
    credential: {
      deviceId: s.deviceId,
      accessToken: s.accessToken,
      accessTokenExpiresAt: s.accessTokenExpiresAt,
      refreshToken: s.refreshToken,
      refreshTokenExpiresAt: s.refreshTokenExpiresAt,
    },
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

// seedAgentredSession inserts one daemon_sessions row + a few journal rows into
// the running agentred's SQLite (WAL, busy_timeout) via node:sqlite. The session
// belongs to the browser's own web-device peer, so session.list (account-wide)
// shows it and the browser can attach + catch up by cursor.
function seedAgentredSession(dbPath, agentredFP) {
  const { DatabaseSync } = requireModule("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const now = Date.now();
    const sessionId = 1001;
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO daemon_sessions
        (peer_fingerprint, peer_session_id, agent_id, cwd, backend_type, lifecycle_state, title, agent_sync_id, provider_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      WEB_FINGERPRINT,
      String(sessionId),
      1,
      "/tmp/e2e-web-project",
      "claudecode",
      "idle",
      "e2e 全链路会话",
      "e2e-agent-sync-1",
      "e2e-fake-1001",
      now,
      now,
    );
    // Journal rows: prior transcript the browser must catch up by cursor.
    // payload is the EventFrame WITHOUT seq (mirror of handlers/runtime.go emit).
    const jstmt = db.prepare(
      `INSERT OR REPLACE INTO daemon_notification_logs
        (peer_fingerprint, peer_session_id, seq, method, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const events = [
      {
        seq: 1,
        event: {
          kind: "text_delta",
          text: "e2e-fake-reply: 上次的旧转录(第 1 行)",
        },
      },
      {
        seq: 2,
        event: {
          kind: "text_delta",
          text: " e2e-fake-reply: 上次的旧转录(第 2 行)",
        },
      },
      { seq: 3, event: { kind: "done" } },
    ];
    for (const ev of events) {
      jstmt.run(
        WEB_FINGERPRINT,
        String(sessionId),
        ev.seq,
        "runtime.event",
        JSON.stringify({ sessionId, event: ev.event }),
        now,
      );
    }
  } finally {
    db.close();
  }
}

function requireModule(name) {
  return createRequire(import.meta.url)(name);
}

function fetchJSON(url, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = {
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    };
    if (opts.cookie) headers.Cookie = opts.cookie;
    const req = request(
      url,
      { method: opts.method ?? "GET", headers, timeout: 10_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try {
            const json = JSON.parse(text);
            resolvePromise(json.data ?? json);
          } catch {
            reject(
              new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`),
            );
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function probe(url) {
  return new Promise((resolvePromise, reject) => {
    const req = request(url, { method: "GET", timeout: 3_000 }, (res) => {
      res.resume();
      resolvePromise(res.statusCode);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function runTool(args) {
  const out = execFileSync(toolBin, args, {
    encoding: "utf8",
    timeout: 120_000,
  });
  return JSON.parse(out);
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const srv = createTcpServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePromise(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
