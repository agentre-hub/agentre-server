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
//      + the account-level workspace (agents, a project and its path on that
//      agentred) that the "start a new conversation from the web" flow reads
//   5. trade the agentred refresh token for a real access JWT, write a claimed
//      agentred state.json, and run the real agentred daemon against the server
//   6. wait until the agentred is online on the relay
//   7. seed the agentred.db session + journal rows (node:sqlite oracle)
//   8. run playwright with the harness env exported
//   9. ALWAYS delete exactly the rows this run seeded, then kill agentred + server
//
// With `--dual` it additionally seeds a kind=desktop device and hands the real
// Wails desktop app (e2e/dual/, playwright.dual.config.ts) everything it needs to
// join that SAME agentred over the account relay — see prepareDesktop. Steps 7
// and the web suite are replaced: the session under test is created by the
// desktop, not seeded.
//
// It is NOT in CI and not part of make test. It depends on the developer's
// database; when that is unreachable the runner fails with a message naming what
// is missing — it never skips and never reports a pass it did not get.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { request } from "node:http";
import {
  createServer as createTcpServer,
  connect as connectTcp,
} from "node:net";
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
const projectDir = join(workDir, "project");
const webserverLog = join(workDir, "webserver.log");
// 「桌面端 + 浏览器」那一档才用到的东西:真 Wails 应用的数据目录、钥匙串与它自己的
// SQLite(spec 的独立 oracle)。
const desktopDataDir = join(workDir, "desktop");
const desktopKeychainDir = join(workDir, "desktop-keychain");
const desktopDB = join(desktopDataDir, "agentre.db");

// The browser's fixed device fingerprint. It must match the peer fingerprint the
// harness seeds the agentred.db session with, so the browser OWNS that session.
const WEB_FINGERPRINT = "e2e-web-fingerprint-0001";

// agentred.db 里被播种的那几条会话(见 seedAgentredSession)。会话 id 与退化行的
// 那两个字段只有这一份来源,经 WEBE2E_SESSIONS 原样透传给 spec(web/harness.ts)。
//
//   - full_chain: 全链路那条,有标题、有 Agent 同步标识、带三段旧转录;
//   - legacy:     R7 到达之前的老会话,既没有标题也没有 Agent 标识 —— 列表必须如实
//                 退化成「工作目录 · 后端 · 状态」并归入「未命名」分组;
//   - running / interrupted: 两个生命周期各一条,移动端按状态分组时各占一组。
//     「等你处理」那一组播种不出来(它是运行时状态),由 spec 现场制造。
const SEEDED_SESSIONS = {
  full_chain_id: 1001,
  legacy_id: 1002,
  legacy_cwd: "/tmp/e2e-legacy-project",
  legacy_backend: "claudecode",
  running_id: 1003,
  interrupted_id: 1004,
  // agent_sync_id 由播种的工作区决定(webe2e/main.go),运行时填。
  agent_sync_id: "",
};

// --dual 才编排桌面端那一侧(e2e/dual/,playwright.dual.config.ts)。默认档保持
// 今天的样子:只有浏览器,不需要 wails 工具链,也不多跑一个 Wails 进程。
// 该标志由本 runner 自己消费,不能混进转发给 playwright 的参数里。
const dualMode = process.argv.slice(2).includes("--dual");
const playwrightArgs = process.argv.slice(2).filter((a) => a !== "--dual");
// 桌面端 Wails IPC 桥的专用端口。**不是** 34216:那个属于 agentre 仓自己的 e2e,
// 两边同时跑时才不会互相复用(或对着对方假绿)。
const DESKTOP_DEVSERVER = "localhost:34217";

let serverProc = null;
let agentredProc = null;
let toolBin = "";
let dsn = "";
let redis = { addr: "", password: "", db: 0 };
let seeded = null;
// 本次播进 agentred.db 的那几条会话(--dual 档不播,保持 null:那一档的会话由桌面端建)。
let seededSessions = null;
let serverURL = "";
let agentreDir = "";

// 只有「被当成脚本直接跑」时才编排；被 import 时(web/runner-config.spec.ts 驱动
// 下面几个纯函数)什么都不做,否则一 import 就会去建服务器、连开发者的库。
const isEntrypoint =
  !!process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err) => {
    console.error(`\n[web-e2e] ${err.message}\n`);
    void finish(1);
  });
}

async function main() {
  const serverDir = resolve(serverRoot);
  agentreDir = locateAgentreCheckout(serverDir);
  if (dualMode) requireWailsToolchain(agentreDir);
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
  // 播种的项目在这台 agentred 上的真实目录(= 新对话的 cwd)。它是 workDir 下的
  // 一个子目录,run 结束随 workDir 一起消失。
  mkdirSync(projectDir, { recursive: true });
  // 桌面端的设备指纹与 bootstrap.newBootFingerprint 同形(16 字节 hex),它同时是
  // 桌面端在 agentred 上的对端身份 —— 会话归属的前半段。
  const desktopFP = randomUUID().replace(/-/g, "");
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
    "--project-path",
    projectDir,
    ...(dualMode ? ["--desktop-fingerprint", desktopFP] : []),
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

  if (dualMode) {
    // 双端场景里那条会话由**桌面端**建(它才是 R7/R18 的生产者),播种一条归浏览器
    // 所有的空会话只会在同一份账号级清单里多出一行与本场景无关的会话。
    console.log(
      "[web-e2e] dual mode → agentred.db left empty (the desktop creates the session)",
    );
  } else {
    console.log("[web-e2e] seeding agentred.db sessions + journal …");
    seededSessions = seedAgentredSession(
      agentredDB,
      seeded.workspace.agent_ready_sync_id,
    );
  }

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
    // 播种的账号级工作区(Agent 与项目路径)。名字与同步标识只有 webe2e/main.go
    // 一份来源,原样透传给 spec。
    WEBE2E_WORKSPACE: JSON.stringify(seeded.workspace),
    // 播进 agentred.db 的那几条会话。--dual 档一条都不播,那时**不导出**这个变量:
    // 读它的用例会当场说清「要经 pnpm web 跑」,而不是对着不存在的会话红一片。
    ...(seededSessions
      ? { WEBE2E_SESSIONS: JSON.stringify(seededSessions) }
      : {}),
  });
  if (dualMode) prepareDesktop(agentreDir, agentredFP);

  const require = createRequire(import.meta.url);
  const playwrightCli = require.resolve("@playwright/test/cli");
  const child = spawn(
    process.execPath,
    [
      playwrightCli,
      "test",
      "--config",
      dualMode ? "playwright.dual.config.ts" : "playwright.web.config.ts",
      ...playwrightArgs,
    ],
    { cwd: here, stdio: "inherit" },
  );
  child.on("exit", (code) => void finish(code ?? 1));
}

// prepareDesktop 备好真 Wails 桌面端那一侧要用的一切,并把它交给
// playwright.dual.config.ts(webServer 由 Playwright 起停,和 e2e/sync 一样)。
//
// 桌面端怎么接上**同一台** agentred:走账号中继,和浏览器同一条路。
//   - 它以本次播种的 kind=desktop 设备身份登录(AGENTRE_E2E_* 那一组 → e2e/fakes/login.go);
//   - e2e/fakes 再按 AGENTRE_E2E_AGENTRED_* 播一条 paired_agentreds 行 + 一个绑定该行的
//     claudecode backend + 一个用它的 Agent。于是桌面端跟这个 Agent 的每一轮都经
//     remote runtime → ConnPool.Borrow → GET /v1/relay/client?daemon_fingerprint=<fp>
//     落到这台 agentred 上 —— 浏览器用的是同一个端点、同一台机器。
//   - paired_agentreds.url 指向一个**故意没人监听**的回环端口:Borrow 会并发跑「局域网
//     直连」与「中继」两条路,本场景要验的是中继那条(浏览器也只有那条),直连当场失败即可。
function prepareDesktop(agentreDir, agentredFP) {
  if (!seeded.desktop) {
    throw new Error(
      "webe2e seed returned no desktop device — --desktop-fingerprint did not reach it",
    );
  }
  rmSync(desktopDataDir, { recursive: true, force: true });
  mkdirSync(desktopDataDir, { recursive: true });
  mkdirSync(desktopKeychainDir, { recursive: true, mode: 0o700 });
  // `wails dev` 的 //go:embed all:frontend/dist 要求这个目录存在(镜像 make dev
  // 与 agentre 自己的 e2e/playwright.config.ts)。
  const distDir = join(agentreDir, "frontend", "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, ".keep"), "");

  Object.assign(process.env, {
    WEBE2E_AGENTRE_DIR: agentreDir,
    WEBE2E_DESKTOP_DEVSERVER: DESKTOP_DEVSERVER,
    WEBE2E_DESKTOP_URL: `http://${DESKTOP_DEVSERVER}`,
    WEBE2E_DESKTOP_DB: desktopDB,
    WEBE2E_DESKTOP_DATA_DIR: desktopDataDir,
    WEBE2E_DESKTOP_KEYCHAIN_DIR: desktopKeychainDir,
    WEBE2E_DESKTOP_FINGERPRINT: seeded.desktop.fingerprint,
    WEBE2E_DESKTOP_LOG: webserverLog,
    // 已登录的桌面端(与 e2e/sync 同一组约定,由 agentre e2e/fakes/login.go 消费)。
    AGENTRE_E2E_SERVER_URL: serverURL,
    AGENTRE_E2E_SERVER_USER_ID: String(seeded.user_id),
    AGENTRE_E2E_DEVICE_ID: String(seeded.desktop.device_id),
    AGENTRE_E2E_DEVICE_FINGERPRINT: seeded.desktop.fingerprint,
    AGENTRE_E2E_REFRESH_TOKEN: seeded.desktop.refresh_token,
    AGENTRE_E2E_KEYCHAIN_DIR: desktopKeychainDir,
    // 这台 agentred 在桌面端上的配对行 + 指向它的远端 Agent(agentre e2e/fakes/remote.go)。
    AGENTRE_E2E_AGENTRED_FINGERPRINT: agentredFP,
    // 端口 1 要 root 才能监听,用户态进程不会占着它 —— 直连当场 ECONNREFUSED,
    // 中继那条路胜出(client.Race:任一路径不可用不构成失败)。
    AGENTRE_E2E_AGENTRED_URL: "ws://127.0.0.1:1",
  });
}

// requireWailsToolchain 在真正开工前确认双端档跑得起来:缺 wails CLI 或缺
// frontend/node_modules 时当场说清缺什么,而不是让 Playwright 的 webServer 等满超时。
function requireWailsToolchain(agentreDir) {
  try {
    execFileSync("wails", ["version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "--dual needs the `wails` CLI on PATH (it runs the real desktop app). " +
        "Install it with `go install github.com/wailsapp/wails/v2/cmd/wails@latest`.",
    );
  }
  if (!existsSync(join(agentreDir, "frontend", "node_modules"))) {
    throw new Error(
      `--dual needs the desktop frontend deps: run \`pnpm install\` in ${join(agentreDir, "frontend")}`,
    );
  }
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
  if (dualMode) reapOrphanVite(agentreDir);

  if (code === 0) {
    rmSync(workDir, { recursive: true, force: true });
  } else {
    console.log(
      `[web-e2e] kept ${workDir} for inspection (server.log, agentred.log, agentred.db, screenshots)`,
    );
  }
  process.exit(code);
}

// 只有编排进程才装信号处理:被 import 时装上去,Playwright 的 worker 会跟着在
// Ctrl-C 时跑 finish() —— 那里会 process.exit 并打印「kept <workDir>」,把真正的
// 收尾盖掉。import 时什么都不做,这条也算在内。
if (isEntrypoint) {
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => void finish(1));
}

// reapOrphanVite 收掉 `wails dev` 关停时遗留的 vite 子进程(它在另一个进程组里,
// Playwright 的 group-kill 够不着;agentre 自己的 e2e/run-e2e.mjs 有同样一段)。
// 按命令行匹配,并限定在这个 agentre checkout 的 frontend 下,绝不误伤别的检出。
function reapOrphanVite(dir) {
  if (!dir) return;
  const frontend = join(dir, "frontend");
  try {
    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process | Where-Object { " +
        `$_.ProcessId -ne $PID -and $_.CommandLine -like '*${frontend}*vite*' } | ` +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
      execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { stdio: "ignore" },
      );
    } else {
      execFileSync("pkill", ["-f", `${frontend}.*vite`], { stdio: "ignore" });
    }
  } catch {
    // 尽力而为的卫生工作:没有可收的进程就什么都不做。
  }
}

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
  const dsn = parseDSN(readFileSync(configPath, "utf8"));
  if (!dsn) throw new Error(`no db.dsn found in ${configPath}`);
  return dsn;
}

function readRedis(serverDir) {
  const configPath = join(serverDir, "configs", "config.yaml");
  return parseRedis(readFileSync(configPath, "utf8"));
}

// yamlBlock 取一个顶层块的正文行(下一个顶层键为止)。按块取值而不是全文正则,
// 是因为 dsn / addr / password / db 这些键名在配置里不止一处:`db:` 既是顶层
// 数据库块的名字,也是 redis 块里的库号。
function yamlBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^${name}:[ \\t]*$`).test(l.replace(/\r$/, "")),
  );
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim() !== "" && !/^[ \t]/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

// blockScalar 取块里某个键的值(已去引号)。找不到键、或值为空时返回 fallback。
function blockScalar(text, block, key, fallback) {
  const body = yamlBlock(text, block);
  if (body === null) return fallback;
  const m = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, "m").exec(body);
  if (!m) return fallback;
  return unquoteScalar(m[1]);
}

/** parseDSN 读 db.dsn(带引号的写法照样读得出);读不到返回 null。 */
export function parseDSN(text) {
  return blockScalar(text, "db", "dsn", "") || null;
}

/** parseRedis 读 redis 段。缺省值与 configs/config.example.yaml 一致。 */
export function parseRedis(text) {
  return {
    addr: blockScalar(text, "redis", "addr", "") || "127.0.0.1:6379",
    password: blockScalar(text, "redis", "password", ""),
    db: Number(blockScalar(text, "redis", "db", "") || "0"),
  };
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
  const text = readFileSync(join(serverDir, "configs", "config.yaml"), "utf8");
  writeFileSync(
    join(cwd, "configs", "config.yaml"),
    rewriteServerConfig(text, { serverDir, port }),
  );
  return cwd;
}

// rewriteServerConfig 把开发者的 configs/config.yaml 改写成这次 run 用的配置:
// 监听本次分配的端口、公开 URL 指回自己、JWT 密钥路径解析成绝对路径(server 跑在
// 临时 cwd 里,相对路径会失效)。纯函数,由 web/runner-config.spec.ts 直接驱动。
export function rewriteServerConfig(text, { serverDir, port }) {
  text = text.replace(
    /(http:\s*\n\s*address:\s*\n\s*-\s*)(.*)/,
    `$1127.0.0.1:${port}`,
  );
  // The browser reaches the SPA through the server itself, so the device-flow
  // verification URI (public_url + /device) must point at the server's own URL.
  text = text.replace(/(public_url:[ \t]*)(.*)/, `$1http://127.0.0.1:${port}`);
  text = flattenRotatedJWTKeys(text);
  text = absolutizeKeyPath(text, "private_key_pem_path", serverDir);
  text = absolutizeKeyPath(text, "public_key_pem_path", serverDir);
  return text;
}

// unquoteScalar 去掉 YAML 标量两端的引号。本仓 configs/config.example.yaml 的
// 路径、DSN、Redis 口令都是带引号写法,照它写出来的 config.yaml 一律带引号;
// 用 (\S+) 捕获会把引号当成值的一部分,路径于是变成 <checkout>/"./runtime/keys/jwt.key",
// server 报 missing JWT key —— 所有读值都必须先过这一道。
function unquoteScalar(raw) {
  const v = (raw ?? "").trim();
  const quoted =
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")));
  return quoted ? v.slice(1, -1) : v;
}

// absolutizeKeyPath 把第一处 key 的值解析成绝对路径,并当场确认文件真的在。
// 缺文件时立刻报出缺哪个文件,而不是让 server 起来之后自己死在 missing JWT key。
function absolutizeKeyPath(text, key, serverDir) {
  const re = new RegExp(`^([ \\t]*${key}:[ \\t]*)(.*)$`, "m");
  const m = re.exec(text);
  if (!m) {
    throw new Error(
      `configs/config.yaml has no ${key} (and no active_kid + keys list to derive it from) — ` +
        `the server cannot sign device JWTs without it`,
    );
  }
  const abs = resolve(serverDir, unquoteScalar(m[2]));
  if (!existsSync(abs)) {
    throw new Error(
      `JWT key file missing: ${abs} (from ${key} in configs/config.yaml)`,
    );
  }
  return text.replace(re, (_all, head) => head + abs);
}

// flattenRotatedJWTKeys 把密钥**轮换**形态摊平成本分支认得的扁平形态。
//
// agentre-server main 在 8651f57 引入了轮换:server.jwt 从两个路径字段变成
// `active_kid:` + `keys:` 列表,开发者的 gitignored config.yaml 已改成那个形状。
// 本分支早于它,internal/bootstrap 的 JWTConfig 只有 private_key_pem_path /
// public_key_pem_path,轮换形态在这里会绑定成空串 → server 起不来。
//
// 两种形态都要认,所以这里只做**字段名适配**:取 active_kid 指名的那一项(取不到
// 就取第一项)的密钥文件——用的是开发者自己的真密钥,不生成、不替换、不削弱任何
// 东西——摊平后写进 harness 自己的临时 cwd,仓库里的配置一个字节都不动。
// 已经是扁平形态的配置原样返回。
function flattenRotatedJWTKeys(text) {
  const lines = text.split("\n");
  const jwtIdx = lines.findIndex((l) => /^[ \t]*jwt:[ \t]*$/.test(l));
  if (jwtIdx < 0) return text;
  const jwtIndent = /^([ \t]*)/.exec(lines[jwtIdx])[1];
  const body = [];
  for (let i = jwtIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = /^([ \t]*)/.exec(line)[1];
    if (indent.length <= jwtIndent.length) break;
    body.push(line);
  }
  const childIndent = body.length
    ? /^([ \t]*)/.exec(body[0])[1]
    : `${jwtIndent}  `;
  // 扁平形态:private_key_pem_path 直接挂在 jwt: 下面(不在 keys: 列表里)。
  const alreadyFlat = body.some((l) =>
    new RegExp(`^${childIndent}private_key_pem_path:`).test(l),
  );
  if (alreadyFlat) return text;
  const activeKID = unquoteScalar(
    /^[ \t]*active_kid:[ \t]*(.*)$/m.exec(body.join("\n"))?.[1] ?? "",
  );
  const entries = parseKeyEntries(body);
  const active = entries.find((e) => e.kid === activeKID) ?? entries[0];
  if (!active) {
    throw new Error(
      "configs/config.yaml uses the JWT key-rotation shape (active_kid + keys) " +
        "but no keys entry with private_key_pem_path / public_key_pem_path could be parsed",
    );
  }
  lines.splice(
    jwtIdx + 1,
    0,
    `${childIndent}private_key_pem_path: ${active.private_key_pem_path}`,
    `${childIndent}public_key_pem_path: ${active.public_key_pem_path}`,
  );
  return lines.join("\n");
}

// parseKeyEntries 读 `keys:` 列表里的每一项(`- kid: …` 起头,字段顺序不限)。
function parseKeyEntries(bodyLines) {
  const entries = [];
  let current = null;
  const field = (obj, s) => {
    const m = /^([A-Za-z0-9_]+):[ \t]*(.*)$/.exec(s.trim());
    if (m && obj) obj[m[1]] = unquoteScalar(m[2]);
  };
  for (const line of bodyLines) {
    const item = /^[ \t]*-[ \t]*(.*)$/.exec(line);
    if (item) {
      if (current) entries.push(current);
      current = {};
      field(current, item[1]);
      continue;
    }
    field(current, line);
  }
  if (current) entries.push(current);
  return entries.filter((e) => e.private_key_pem_path && e.public_key_pem_path);
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
          (await startupDiagnosis()),
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
          (await startupDiagnosis()),
      );
    }
    await sleep(500);
  }
}

/**
 * summarizeStartupFailure 从 server.log 里挑出最后一条**它自己报的**错误行。
 * 没有这样的行时返回 null(由调用方去探测依赖)。
 *
 * 这一步是「说出缺什么」的第一手证据:服务器起不来的原因五花八门(密钥文件读不到、
 * 端口被占、迁移失败……),未经探测就断言「PostgreSQL 或 Redis 不可达」会把读者
 * 引向完全无关的子系统 —— 本轮的运行时验证正是被这句话挡了一次。
 */
export function summarizeStartupFailure(logText) {
  const lines = (logText ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (
      /error|fatal|panic|missing|refused|denied|timeout|no such file/i.test(
        lines[i],
      )
    ) {
      return lines[i].trim();
    }
  }
  return null;
}

// startupDiagnosis 组织服务器起不来时给人看的那句话:先服务器日志自己的最后一条
// 错误(决定性),日志里没有错误行时才去 TCP 探测 PostgreSQL 与 Redis,并如实说
// 哪个连得上、哪个连不上。
async function startupDiagnosis() {
  let logText = "";
  try {
    logText = readFileSync(serverLog, "utf8");
  } catch {
    // 日志还没来得及产生
  }
  const decisive = summarizeStartupFailure(logText);
  if (decisive) {
    return `The server's own last error was: ${decisive}\nSee ${serverLog}`;
  }
  const probes = await probeDependencies();
  return (
    `server.log has no error line; probed its dependencies instead:\n  ${probes.join("\n  ")}\n` +
    `See ${serverLog}`
  );
}

// probeDependencies TCP 探测配置里那两个依赖,逐个如实报结果。
async function probeDependencies() {
  const targets = [];
  try {
    const u = new URL(dsn);
    targets.push({
      label: `PostgreSQL ${u.hostname}:${u.port || 5432} (db.dsn)`,
      host: u.hostname,
      port: Number(u.port || 5432),
    });
  } catch {
    // 不回显 dsn 本身:它带着口令,而这条消息会被贴进日志与报告里。
    targets.push({
      label: "PostgreSQL (db.dsn is not a URL this harness can parse)",
    });
  }
  const [rhost, rport] = redis.addr.split(":");
  targets.push({
    label: `Redis ${redis.addr}`,
    host: rhost,
    port: Number(rport || 6379),
  });

  const out = [];
  for (const t of targets) {
    if (!t.host) {
      out.push(`${t.label}: not probed`);
      continue;
    }
    const err = await probeTCP(t.host, t.port);
    out.push(
      err ? `${t.label}: UNREACHABLE — ${err}` : `${t.label}: reachable`,
    );
  }
  return out;
}

// probeTCP 连一下就断,连得上返回 null,连不上返回原因。
function probeTCP(host, port, timeout = 3_000) {
  return new Promise((resolvePromise) => {
    const sock = connectTcp({ host, port });
    const done = (err) => {
      sock.destroy();
      resolvePromise(err);
    };
    sock.setTimeout(timeout, () => done(`no answer within ${timeout}ms`));
    sock.on("connect", () => done(null));
    sock.on("error", (e) => done(e.message));
  });
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

// seedAgentredSession inserts the daemon_sessions rows + a few journal rows into
// the running agentred's SQLite (WAL, busy_timeout) via node:sqlite. Every seeded
// session belongs to the browser's own web-device peer, so session.list
// (account-wide) shows them and the browser can attach + catch up by cursor.
//
// 四条会话见 SEEDED_SESSIONS 的说明:全链路那条带旧转录,另外三条是 R5b 的列表
// 素材(老会话的退化行 + 两个生命周期)。返回值原样交给 spec。
function seedAgentredSession(dbPath, agentSyncID) {
  const { DatabaseSync } = requireModule("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: false });
  const fixtures = { ...SEEDED_SESSIONS, agent_sync_id: agentSyncID };
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const now = Date.now();
    const sessionId = fixtures.full_chain_id;
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO daemon_sessions
        (peer_fingerprint, peer_session_id, agent_id, cwd, backend_type, lifecycle_state, title, agent_sync_id, provider_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSession = (id, s) =>
      stmt.run(
        WEB_FINGERPRINT,
        String(id),
        1,
        s.cwd,
        s.backend,
        s.lifecycle,
        s.title,
        s.agentSyncID,
        s.providerSessionID,
        now,
        now,
      );
    insertSession(sessionId, {
      cwd: "/tmp/e2e-web-project",
      backend: "claudecode",
      lifecycle: "idle",
      title: "e2e 全链路会话",
      agentSyncID: "e2e-agent-sync-1",
      providerSessionID: "e2e-fake-1001",
    });
    // R7 到达之前的老会话:标题、Agent 同步标识与 provider_session_id 三样都没有,
    // 就是升级前那条 daemon 写下的行的样子。列表必须如实退化,不许猜一个标题。
    insertSession(fixtures.legacy_id, {
      cwd: fixtures.legacy_cwd,
      backend: fixtures.legacy_backend,
      lifecycle: "idle",
      title: "",
      agentSyncID: "",
      providerSessionID: "",
    });
    // 两个生命周期各一条,都挂在播种工作区的那个 Agent 上:桌面按 Agent 分组时它们
    // 落在同一组(组名要经同步标识解析成 Agent 名),移动按状态分组时各占一组。
    // daemon 启动清扫(InterruptAll)早于这一步,不会把它们改回去。
    insertSession(fixtures.running_id, {
      cwd: "/tmp/e2e-web-project",
      backend: "claudecode",
      lifecycle: "running",
      title: "e2e 运行中的会话",
      agentSyncID: agentSyncID,
      providerSessionID: "e2e-fake-1003",
    });
    insertSession(fixtures.interrupted_id, {
      cwd: "/tmp/e2e-web-project",
      backend: "claudecode",
      lifecycle: "interrupted",
      title: "e2e 已中断的会话",
      agentSyncID: agentSyncID,
      providerSessionID: "e2e-fake-1004",
    });
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
  return fixtures;
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
