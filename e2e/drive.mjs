// 验证驱动器:一次调用一个动作,打在 `pnpm drive up` 留在那儿的浏览器上。
// 它替掉的是「为看一眼而写一条一次性 spec」—— 你看、你动、再看,每一次调用都当场
// 追加到本场景的 logs/drive.log 里。
//
//   node drive.mjs snapshot                    # 屏幕上有什么,以及怎么定位它
//   node drive.mjs click "testid=nav-devices"
//   node drive.mjs shot 01-devices
//   node drive.mjs sql "select status, count(*) from device_flow_codes group by status"
//   node drive.mjs logs 40
//
// 隔离不是这个文件的判断:它连的是 `pnpm serve`(或 --base)定下的那个 target,
// 每个碰到的 URL 都过 assertSanctionedURL(lib/drive-target.mjs)。
//
// 与桌面端 `agentre/e2e/drive.mjs` 同形 —— 两个仓独立,不共享代码,但同一套命令、
// 同一套选择器 DSL、同一份 drive.log。区别只在这边的 target 是 server + 浏览器,
// oracle 是本轮 E2E 专库，而不是页面自身的渲染结果。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IsolationError,
  assertReadOnlySQL,
  assertSanctionedURL,
  mysqlInvocation,
  parseArgs,
  parseRoleSpec,
  resolveTargetURL,
  scenarioPaths,
  sessionCookie,
  shotPath,
  splitLocator,
  targetForDrive,
} from "./lib/drive-target.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // e2e/
const stateDir = join(here, ".drive");
const sessionPath = join(stateDir, "session.json");
const serveEnvPath = join(stateDir, "serve-env.json");
const scratchRoot = join(here, "scratch");
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_CDP_PORT = 9333;

function readJSON(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** 本次运行的证据落点。一个场景一个目录 —— docs/verification.md。 */
function scenarioDirs(flags) {
  const slug =
    flags.scenario || process.env.AGENTRE_VERIFY_SCENARIO || "_unscoped";
  const dirs = scenarioPaths(scratchRoot, slug);
  mkdirSync(dirs.logs, { recursive: true });
  mkdirSync(dirs.screenshots, { recursive: true });
  return dirs;
}

function record(dirs, line) {
  appendFileSync(join(dirs.logs, "drive.log"), `${line}\n`);
}

function requireLiveSession() {
  const session = readJSON(sessionPath);
  if (!session) {
    throw new IsolationError(
      "no verification browser is up. Start one: `pnpm drive up` " +
        "(after `pnpm serve`, or with --base for a logged-out target)",
    );
  }
  return session;
}

function locate(page, spec, flags) {
  const { kind, value } = splitLocator(spec);
  let locator;
  switch (kind) {
    case "testid":
      locator = page.getByTestId(value);
      break;
    case "role": {
      const { role, name } = parseRoleSpec(value);
      locator = page.getByRole(role, name === undefined ? {} : { name });
      break;
    }
    case "text":
      locator = page.getByText(value);
      break;
    case "label":
      locator = page.getByLabel(value);
      break;
    case "placeholder":
      locator = page.getByPlaceholder(value);
      break;
    default:
      locator = page.locator(spec);
  }
  return Number.isInteger(Number(flags.nth))
    ? locator.nth(Number(flags.nth))
    : locator.first();
}

async function attach(session) {
  // 应用死掉和空白页透过 CDP 长得一模一样:浏览器答应、页面是空的,snapshot 报
  // 「0 elements」像是界面本来就空。先问 target 自己,让失败自报家门。
  try {
    await fetch(session.baseURL, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(
      `nothing is serving ${session.baseURL} any more — the server or vite behind ` +
        "it stopped. `pnpm drive logs` for why, then bring it back up.",
    );
  }
  const { chromium } = await import("@playwright/test");
  let browser;
  try {
    browser = await chromium.connectOverCDP(session.cdpURL, {
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(
      `cannot reach the verification browser at ${session.cdpURL} — still up? ` +
        `(\`pnpm drive status\`)\n${err.message}`,
    );
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("the verification browser has no context");
  const pages = context.pages();
  const page =
    pages.find((p) => p.url().startsWith(session.baseURL)) ||
    pages[0] ||
    (await context.newPage());
  return { browser, page };
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function urlReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * 起一个**活过单次调用**的浏览器,并把这次的 target 定下来。
 * 无头是默认:一次验证不该抢走屏幕和焦点。--headed 是给你想看着它走的时候用的。
 */
async function up(flags) {
  const target = targetForDrive(flags, readJSON(serveEnvPath));
  const { baseURL, serveEnv } = target;
  if (!baseURL) {
    throw new IsolationError(
      "no target: run `pnpm serve` first (seeded, signed in), or name one with " +
        "--base http://127.0.0.1:5174 for a logged-out UI check",
    );
  }
  assertSanctionedURL({ baseURL }, baseURL);
  const cdpPort = Number(flags.port ?? DEFAULT_CDP_PORT);
  const cdpURL = `http://127.0.0.1:${cdpPort}`;
  const existing = readJSON(sessionPath);
  if (
    existing &&
    !flags.fresh &&
    (await urlReady(`${cdpURL}/json/version`, 300))
  ) {
    console.log(`already up: ${existing.baseURL} (cdp ${existing.cdpURL})`);
    return 0;
  }
  if (existing) await down({});

  const { chromium } = await import("@playwright/test");
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    console.log("[drive] installing chromium …");
    spawnSync("pnpm", ["exec", "playwright", "install", "chromium"], {
      cwd: here,
      stdio: "inherit",
    });
  }
  mkdirSync(stateDir, { recursive: true });
  const browserDir = join(stateDir, "browser");
  rmSync(browserDir, { recursive: true, force: true });
  const [w, h] = String(flags.viewport ?? "1440x900").split("x");
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${browserDir}`,
    `--window-size=${w},${h}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--password-store=basic",
    "--use-mock-keychain",
  ];
  if (!flags.headed) args.push("--headless=new");
  args.push(baseURL);

  const proc = spawn(executable, args, { detached: true, stdio: "ignore" });
  proc.unref();
  const version = await urlReady(`${cdpURL}/json/version`, 30_000);
  if (!version) throw new Error(`chromium did not expose CDP on :${cdpPort}`);

  const session = {
    baseURL,
    cdpPort,
    cdpURL,
    browserPid: proc.pid ?? null,
    headless: !flags.headed,
    seeded: !!serveEnv,
    serverLog: serveEnv?.serverLog ?? null,
    dsn: serveEnv?.dsn ?? null,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);

  // 播种的会话 Cookie 要落在浏览器自己的 context 上,后面每次 attach 都带着它。
  if (serveEnv) {
    const { browser, page } = await attach(session);
    try {
      await browser.contexts()[0].addCookies([sessionCookie(serveEnv)]);
      await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    } finally {
      await browser.close().catch(() => {});
    }
  }
  console.log(
    [
      `${session.headless ? "headless" : "headed"} ${version.Browser} on ${cdpURL}`,
      `target ${baseURL}${session.seeded ? " (signed in as the seeded account)" : ""}`,
      "",
      "drive it (one action per call, every call recorded):",
      "  pnpm drive snapshot --scenario <slug>",
      '  pnpm drive click "testid=…"   pnpm drive shot 01-name',
      "  pnpm drive down",
    ].join("\n"),
  );
  return 0;
}

async function down() {
  const session = readJSON(sessionPath);
  if (!session) {
    console.log("nothing is up");
    return 0;
  }
  // detached 起的 chromium 是**进程组组长**,先打整组;组不在了再打单个 pid。
  // 只打 pid 的话主进程会活下来占着 CDP 端口,下一次 up 就「已经有人在了」。
  const signal = (sig) => {
    for (const target of [-session.browserPid, session.browserPid]) {
      try {
        process.kill(target, sig);
        return true;
      } catch {
        /* 不是组长 / 已经没了 */
      }
    }
    return false;
  };
  if (session.browserPid) {
    signal("SIGTERM");
    // 没走干净就升级:说「停了」而它还在,下一次 up 会连上一个上轮的浏览器。
    if (await urlReady(`${session.cdpURL}/json/version`, 3000))
      signal("SIGKILL");
  }
  rmSync(sessionPath, { force: true });
  const stillUp = await urlReady(`${session.cdpURL}/json/version`, 1000);
  console.log(
    stillUp
      ? `WARNING: something still answers on ${session.cdpURL} — kill it by hand`
      : `stopped the verification browser (${session.baseURL})`,
  );
  return stillUp ? 1 : 0;
}

async function status() {
  const session = readJSON(sessionPath);
  if (!session) {
    console.log("down");
    return 1;
  }
  const version = await urlReady(`${session.cdpURL}/json/version`, 500);
  const serving = await fetch(session.baseURL, {
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => `${r.status}`)
    .catch(() => "unreachable");
  console.log(
    [
      `target   ${session.baseURL} (${serving})`,
      `browser  ${version ? version.Browser : "NOT RESPONDING"} on ${session.cdpURL}`,
      `seeded   ${session.seeded ? "yes — signed in" : "no — logged-out target"}`,
      `since    ${session.startedAt}`,
    ].join("\n"),
  );
  return version ? 0 : 1;
}

// ── 动作 ────────────────────────────────────────────────────────────────────

const COMMANDS = {
  async goto({ page, session, rest }) {
    const url = assertSanctionedURL(
      session,
      resolveTargetURL(rest[0] ?? "/", session.baseURL),
    );
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return `at ${page.url()}`;
  },

  async click({ page, rest, flags }) {
    await locate(page, rest[0], flags).click({
      timeout: Number(flags.timeout ?? DEFAULT_TIMEOUT),
    });
    return `clicked ${rest[0]} (now at ${page.url()})`;
  },

  async fill({ page, rest, flags }) {
    await locate(page, rest[0], flags).fill(rest.slice(1).join(" "), {
      timeout: Number(flags.timeout ?? DEFAULT_TIMEOUT),
    });
    return `filled ${rest[0]}`;
  },

  async press({ page, rest, flags }) {
    // `press <key>` 打给当前焦点;`press <locator> <key>` 打给某个元素。
    if (rest.length === 1) {
      await page.keyboard.press(rest[0]);
      return `pressed ${rest[0]}`;
    }
    await locate(page, rest[0], flags).press(rest[1], {
      timeout: Number(flags.timeout ?? DEFAULT_TIMEOUT),
    });
    return `pressed ${rest[1]} on ${rest[0]}`;
  },

  async wait({ page, rest, flags }) {
    await locate(page, rest[0], flags).waitFor({
      state: flags.state ?? "visible",
      timeout: Number(flags.timeout ?? DEFAULT_TIMEOUT),
    });
    return `${rest[0]} is ${flags.state ?? "visible"}`;
  },

  /** 屏幕上有什么、怎么定位它。看不懂发生了什么时第一个跑的就是它。 */
  async snapshot({ page, rest, flags }) {
    const items = await page.evaluate(
      ({ rootSel, limit }) => {
        const root = rootSel ? document.querySelector(rootSel) : document.body;
        if (!root) return null;
        const SELECTOR =
          'button, a[href], input, select, textarea, [role], [data-testid], [contenteditable="true"], h1, h2, h3, [aria-label]';
        const out = [];
        const seen = new Set();
        for (const el of root.querySelectorAll(SELECTOR)) {
          if (out.length >= limit) break;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width === 0 || rect.height === 0) continue;
          if (
            style.visibility === "hidden" ||
            style.display === "none" ||
            style.opacity === "0"
          )
            continue;
          const testid = el.getAttribute("data-testid") || "";
          const role = el.getAttribute("role") || el.tagName.toLowerCase();
          const name = (
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.innerText ||
            el.value ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 70);
          const key = `${role}|${testid}|${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const state = [];
          if (el.disabled) state.push("disabled");
          if (el.getAttribute("aria-selected") === "true")
            state.push("selected");
          const expanded = el.getAttribute("aria-expanded");
          if (expanded !== null) state.push(`expanded=${expanded}`);
          out.push({
            role,
            testid,
            name,
            state: state.join(","),
            y: Math.round(rect.top),
            x: Math.round(rect.left),
          });
        }
        return out;
      },
      { rootSel: rest[0] ?? null, limit: Number(flags.limit ?? 120) },
    );
    if (items === null) throw new Error(`no element matches ${rest[0]}`);
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = items.map((it) => {
      const addr = it.testid ? `testid=${it.testid}` : `role=${it.role}`;
      return `  ${addr.padEnd(42)} [${it.role}] ${it.name}${it.state ? `  (${it.state})` : ""}`;
    });
    console.log(`${page.url()}\n${lines.join("\n")}`);
    return `${items.length} elements`;
  },

  async text({ page, rest, flags }) {
    const locator = rest[0]
      ? locate(page, rest[0], flags)
      : page.locator("body");
    const value = (
      await locator.innerText({
        timeout: Number(flags.timeout ?? DEFAULT_TIMEOUT),
      })
    ).trim();
    console.log(value.slice(0, 4000));
    return `${value.length} chars`;
  },

  async shot({ page, rest, flags, dirs }) {
    const name = (rest[0] || "shot").replace(/[^\w.-]/g, "-");
    const path = shotPath(dirs.root, name);
    const shooter = rest[1] ? locate(page, rest[1], flags) : page;
    await shooter.screenshot({
      path,
      fullPage: rest[1] ? undefined : Boolean(flags.full),
    });
    console.log(path);
    return `saved ${path}`;
  },

  async viewport({ page, rest }) {
    const [w, h] = String(rest[0] ?? "1440x900")
      .split("x")
      .map(Number);
    await page.setViewportSize({ width: w, height: h });
    return `viewport ${w}x${h}`;
  },

  async eval({ page, rest }) {
    const result = await page.evaluate(rest.join(" "));
    console.log(JSON.stringify(result, null, 2));
    return "evaluated";
  },

  /**
   * 独立 oracle:读应用写进去的数据,而不是它渲染出来的界面。只读 ——
   * 一次验证观察状态,不制造状态。
   *
   * 只连接 `pnpm serve` 的本轮 E2E 专库。
   */
  async sql({ session, rest }) {
    const query = assertReadOnlySQL(rest.join(" "));
    if (!session.dsn) {
      throw new Error(
        "this session has no database DSN — it was started with --base, not by " +
          "`pnpm serve`. Query your own database directly, or re-run through serve.",
      );
    }
    const { args, env } = mysqlInvocation(session.dsn, query);
    try {
      const out = execFileSync("mysql", args, {
        encoding: "utf8",
        // 口令只从环境进去,不进 argv —— 否则同机 `ps` 就能看到它。
        env: { ...process.env, ...env },
      });
      console.log(out.trim());
      return "queried";
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(
          "the mysql client is not on PATH — install it, or query the DSN yourself",
        );
      }
      throw new Error(
        (err.stderr || err.message).toString().trim().split("\n")[0],
      );
    }
  },

  /** 正式 server 日志。浏览器没了也照样能看 —— 写报告时要用。 */
  async logs({ session, rest, flags }) {
    const lines = Number(rest[0]) || Number(flags.limit) || 40;
    const files = [session.serverLog].filter(Boolean);
    if (!files.length) {
      throw new Error(
        "this session has no logs — it was started with --base, not by `pnpm serve`",
      );
    }
    for (const file of files) {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const tail = readFileSync(file, "utf8")
        .split("\n")
        .slice(-lines)
        .join("\n");
      console.log(`--- ${file}\n${tail}`);
    }
    return `tailed ${files.length} files`;
  },
};

const LIFECYCLE = { up, down, status };

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const { command, rest, flags } = parsed;

  if (LIFECYCLE[command]) return LIFECYCLE[command](flags);
  if (!command || !COMMANDS[command]) {
    console.error(
      `usage: pnpm drive <up|down|status|${Object.keys(COMMANDS).join("|")}> [args] ` +
        "[--scenario <slug>] [--base URL] [--headed] [--nth N] [--state visible|hidden] " +
        "[--timeout ms] [--limit N] [--full]",
    );
    return 2;
  }

  const session = requireLiveSession();
  const dirs = scenarioDirs(flags);
  const started = new Date();
  const printable = [command, ...rest].join(" ");

  let ctx = null;
  try {
    // sql 与 logs 读的是应用自己写下的文件,不需要浏览器,而且浏览器关掉之后
    // 还得能用 —— 写报告的时候正是这个时候。
    if (command !== "sql" && command !== "logs") ctx = await attach(session);
    const summary = await COMMANDS[command]({
      ...ctx,
      session,
      rest,
      flags,
      dirs,
    });
    record(
      dirs,
      `${started.toISOString()} drive ${printable}\n    ok: ${summary}`,
    );
    // 回执也打到 stdout:否则 click / fill / wait 成功时**一声不响**,分不清是做了
    // 还是没做。命令自己的产出(snapshot / text / sql)已经先打过了。
    console.log(`ok: ${summary}`);
    return 0;
  } catch (err) {
    record(
      dirs,
      `${started.toISOString()} drive ${printable}\n    FAILED: ${err.message.split("\n")[0]}`,
    );
    console.error(
      err instanceof IsolationError
        ? `${err.name}: ${err.message}`
        : err.message,
    );
    if (ctx)
      console.error(
        "hint: `pnpm drive snapshot` shows what is actually on screen",
      );
    return 1;
  } finally {
    // 只断开这一个客户端;浏览器和被驱动的应用继续活着,等下一次调用。
    if (ctx) await ctx.browser.close().catch(() => {});
  }
}

main().then((code) => process.exit(code));
