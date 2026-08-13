# e2e — four entry points, one rule

Everything here drives the real app in a real browser. What differs is **who
decides the steps** — a committed spec, or you, right now.

|                  | `pnpm smoke`                        | `pnpm serve` + `pnpm drive`                | `pnpm scratch`                           | `pnpm web` / `pnpm dual`                |
| ---------------- | ----------------------------------- | ------------------------------------------ | ---------------------------------------- | --------------------------------------- |
| Committed        | Yes, runs in CI                     | The harness is; the evidence is not        | **No** — `scratch/` is gitignored        | Yes, on demand — never in CI            |
| Steps decided by | the spec                            | **you, one command at a time**             | the spec you just wrote                  | the spec                                |
| Purpose          | stop basic functionality regressing | "does this actually work / look right?"    | replay a sequence, or timing/concurrency | the full chain, incl. a real `agentred` |
| External deps    | all mocked                          | real server + real MySQL/Redis             | may hit a real environment               | real everything                         |
| Output           | a green light in CI                 | `scratch/<scenario>/` + what you read back | `scratch/<scenario>/report.md`           | a green light, on demand                |
| Config           | `playwright.config.ts`              | none — `drive.mjs` attaches over CDP       | `playwright.scratch.config.ts`           | `playwright.web.config.ts` / `.dual.`   |

**The rule: drive it before you write a spec.** A spec asserts only what you
thought of in advance, and a one-line change costs a whole cold run. Write one
when the sequence must be **replayed** — not to look at something once.

## Running

```bash
cd e2e
pnpm install

pnpm smoke              # committed smoke suite (desktop + mobile)
pnpm serve              # a seeded real environment, held open until Ctrl-C
pnpm drive up           # a browser that outlives each command
pnpm scratch            # throwaway specs under scratch/
pnpm web                # full chain: real server + real agentred
```

`smoke` and `scratch` run `playwright install chromium` first, and `drive`
installs it on first `open`. That costs ~2s once the browser is there, and it is
what stops the failure mode where bumping `@playwright/test` leaves a stale build
on disk and **every** spec goes red with `Executable doesn't exist` — which reads
like the app broke, not the browser.

From the repo root, `make test-e2e` runs the smoke track.

Both spec tracks run every spec against **two projects — `desktop-chromium` and
`mobile-chromium`**. Both are supported form factors, so a desktop-only pass
gives no signal about mobile layout. Narrow to one while iterating:

```bash
pnpm smoke --project=desktop-chromium
pnpm smoke -g "theme"
```

## Driving by hand (`pnpm serve` + `pnpm drive`)

`pnpm drive up` leaves a browser running; every later call performs **one action**
against it and records itself. This is the same driver the desktop repo uses
(`agentre/e2e/drive.mjs`) — same commands, same selector DSL, same `drive.log`.
The repos share no code, only the workflow.

```bash
export AGENTRE_VERIFY_SCENARIO=2026-08-13-console   # every call records into this scenario

pnpm drive up                                  # target = pnpm serve's URL, signed in
pnpm drive up --base http://127.0.0.1:5174     # or a logged-out target you started yourself
pnpm drive snapshot                            # what is on screen, and how to address it
pnpm drive click "testid=nav-devices"
pnpm drive fill "label=User code" A4F-7Q2
pnpm drive text "main"                         # read the page back
pnpm drive sql "select status from device_flow_codes where user_code = 'A4F-7Q2'"
pnpm drive shot 01-devices
pnpm drive viewport 390x844                    # the other form factor
pnpm drive logs 40                             # server + agentred logs
pnpm drive down
```

**Start with `snapshot`.** It lists every visible interactive element with the
address to reach it (`testid=…`, `role=…`), sorted top-to-bottom — so you write
selectors from what is on screen instead of guessing from source. Prefer
`testid=`: visible text is i18n'd here and moves.

Each call connects over CDP, acts, and disconnects; the browser and its cookies,
`localStorage` and current page stay put. `up` seeds the session cookie from
`pnpm serve`'s handoff, so you start signed in rather than at GitHub OAuth.

Four guards are mechanical, not conventions to remember:

- **Only this run's own origin is ever driven.** Any other URL is refused —
  including another port on your own machine, which is likely the `make dev` you
  are actually working in.
- **The oracle is read-only.** `drive sql` accepts only `SELECT` / `WITH` /
  `EXPLAIN` / `SHOW`: a verification observes state, it does not manufacture it.
  `--db agentred` reads that run's `agentred.db` instead of MySQL.
- **Evidence stays in its scenario.** `shot` writes under
  `scratch/<scenario>/screenshots/`; a name containing `..` is refused.
- **Nothing takes over your screen.** The browser is headless; `--headed` when
  you want to watch.

Every call — including the failures — is appended to
`scratch/<scenario>/logs/drive.log` as it happens, so the report cites a record
written during the run rather than one reconstructed after it.

`sql` and `logs` need no browser, and keep working after `down` — which is when
you are writing the report up.

## What `pnpm serve` gives you

`pnpm serve` is `run-e2e-web.mjs --serve`: everything `pnpm web` builds and
seeds, and then **nothing** — no spec runs, the environment simply stays up:

```
pnpm serve
  ├─ builds frontend + server + webe2e + agentred, starts the server on a free port
  ├─ seeds ONE throwaway account + a browser session + an online agentred
  ├─ writes .drive/serve-env.json  ← `pnpm drive up` reads it and lands signed in
  └─ waits. Ctrl-C deletes exactly the rows it seeded, then stops everything.
```

Without it, that environment existed only for the lifetime of a spec run, so
"look at this page once" cost a full cold start and then vanished.

The handoff file carries the session cookie **and the database DSN** (that is what
`drive sql` queries), so treat it as a credential; it is gitignored and removed on
Ctrl-C. If a stale one survives a crash, `pnpm drive up` will land on a dead
address — delete `.drive/` and re-run `pnpm serve`.

### When your `configs/config.yaml` is `source: etcd`

It will not work, and not only because the runner reads `db.dsn` out of the file.
With a non-`file` source, cago **replaces the whole config source** — the local
file is used only to find etcd (`configs/config.go`, `init`). So everything comes
from etcd, including `http.address`, and the server this runner starts would bind
whatever that says (`0.0.0.0:8443`) instead of the free port the run picked. The
isolation the harness is built on is gone, and it collides with your own
`make dev`. The etcd copy also tends to describe a _deployed_ box — ours carries
`/root/...` JWT key paths that do not exist on a laptop.

Point the run at a file-based config instead:

```bash
WEBE2E_CONFIG_DIR=/path/to/dir pnpm serve   # dir/configs/config.yaml, source: file
```

Compose that file from the etcd values (`db`, `redis`, `server`), set
`source: file`, and point the JWT paths at this checkout's `runtime/keys/`. The
runner assigns the port itself. Everything else — seeding, the online `agentred`,
cleanup — then works unchanged.

## Why two config files and not just .gitignore

`.gitignore` stops scratch being **committed**. It does nothing about scratch
being **picked up by a local run** — the files are sitting right there on disk.
So the smoke config `testIgnore`s `scratch/**`, and the scratch config points
`testDir` at it. The pair is what keeps CI unable to see scratch while it stays
runnable locally. Change one and you get scratch in CI, or scratch that no
longer runs.

The smoke config also `testIgnore`s `web/**` and `dual/**`: those are the two
**on-demand** full-chain tracks, each with its own config
(`playwright.web.config.ts` / `playwright.dual.config.ts`), and their specs read
harness env vars that only `run-e2e-web.mjs` sets. A smoke run that picks them up
dies at module load on `WEBE2E_SERVER_URL` before a single assertion runs —
that is exactly how CI bit once (web/ added without the smoke config learning
about it).

Three specs under `web/` are the exception: `runner-config.spec.ts`,
`runner-serve.spec.ts` and `drive-cli.spec.ts` drive pure functions out of
`run-e2e-web.mjs` and `lib/drive-target.mjs`, so they need no environment at
all. They live there because what they guard is this harness itself. Run them
alone:

```bash
pnpm exec playwright test --config playwright.web.config.ts web/drive-cli.spec.ts
```

## Hermetic guarantees

- **Dedicated port** (`5199`, see `fixtures/ports.ts`), deliberately not the dev
  port. Connecting to whatever you happen to have running by hand means testing
  another branch, with dirty data.
- **Explicit `127.0.0.1` bind.** Without `--host`, vite listens on `localhost`
  only, which on macOS may resolve to `::1` first — the health check against
  `127.0.0.1` then hangs until timeout.
- **A startup assertion** (`assertIsAppUnderTest`) that what answered on the port
  really is this app. It asserts on something React actually rendered, not just
  `<title>` and `#root` — both of those survive the whole React tree crashing.
- **Protocol mocks** in `fixtures/app.ts`, wrapping responses in the backend's
  `{code, msg, data}` envelope. A bare object makes `src/lib/api.ts` throw, which
  shows up as "I mocked success but it took the failure path".
- **No custom localStorage-clearing fixture.** Playwright already gives each test
  a fresh browser context. An `addInitScript` that clears preferences re-runs on
  _every_ navigation, so `page.reload()` wipes what the test just set — turning
  working persistence into a red test.

`drive` shares none of this on purpose: it is pointed at whatever you tell it to
drive, and it keeps one browser across commands precisely so state accumulates.
That is the opposite of what a suite needs and exactly what looking at something
needs.

## What earns a place in the smoke track

Only: the app boots, routing and auth redirects, core device-flow UI, theme and
language switching, no horizontal overflow on mobile. That is roughly the whole
list — the suite should stay seconds long.

Everything else goes to `scratch/`. Promoting a scratch spec to smoke is a
separate, deliberate decision, not something that happens because it was handy.

## Needing a real backend

The smoke track runs against the vite dev server with the API mocked, so it needs
no MySQL or Redis. Full-stack flows (real device flow, migrations, session
cookies) need both, plus the Go server. `pnpm serve` arranges all of it; to drive
it with a spec instead:

```bash
go run ./cmd/server                              # real backend on :8443
cd e2e && E2E_SCRATCH_AUTOSTART=1 pnpm scratch
```

`E2E_SCRATCH_AUTOSTART=1` brings the frontend up on the dedicated port 5199, and
vite proxies `/v1` from there to `127.0.0.1:8443` (`frontend/vite.config.ts`) —
so the browser still talks to a server this run owns, while the API calls land on
the real backend. A spec reaches that backend by simply **not** calling the
`mock*` helpers from `fixtures/app.ts`; they are opt-in, there is no global
mocking to switch off. `make dev` works too, but it also starts a second vite on
5174 that the run does not use.

**MySQL and Redis come from `configs/config.yaml`** — the server loads it
through `configs.NewConfig("agentre-server")` in `cmd/server/main.go`, so
`db.dsn` and `redis.addr` decide what a scratch run actually writes to. Point
them at your own instances; the file is gitignored and
`configs/config.example.yaml` is the template.

Those belong in `scratch/`, not in the committed smoke suite — they are slow,
they need infrastructure, and they will be the first thing to turn flaky in CI.

## The dual-end run (`pnpm dual`) — the desktop app and a browser on one agentred

`pnpm web` (`run-e2e-web.mjs`) drives a real browser against a real server + a
real `agentred`. `pnpm dual` is the same runner with `--dual`, and it adds the
**second end**: the real Wails desktop app.

```
pnpm dual  →  node run-e2e-web.mjs --dual
  ├─ everything `pnpm web` does (server, seeded account, agentred, cleanup)
  ├─ plus a seeded kind=desktop device + refresh token
  └─ playwright.dual.config.ts
       ├─ webServer: wails dev -tags e2e -devserver 34217   (the agentre checkout)
       └─ one test (dual/desktop-and-web.spec.ts) driving BOTH ends
```

It exists because a handful of requirements are only decidable with two ends on
one machine at the same time: the desktop puts a session's title + its agent's
account-level sync id on the agentred (R7), the browser's message must land in
the desktop's transcript as a real user row with a "from &lt;device&gt;" mark
(R18/R19), both ends see one live stream (R6b), and a decision answered by one
end tells the other it has already been handled (R10b).

Two things it needs that the browser-only run does not:

| Piece                                                             | Why                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wails` on PATH + `frontend/node_modules` in the agentre checkout | the desktop app is built and run for real; the runner checks both up front and names what is missing                                                                                                                                               |
| `agentre` `e2e/fakes/remote.go` (`//go:build e2e`)                | the desktop joins **that** agentred the same way the browser does — over the account relay. The fake seeds the paired-machine row + an agent bound to it, which is what "claim this machine" would have left behind; without the env it is a no-op |

Gotchas learned building it (see the spec comments for the full reasoning):

- **The desktop stays receptive on a session for as long as its pooled connection
  lives — not only while one of its own turns is in flight.** Building this suite
  first found the opposite, and it was a product defect: at refcount zero the
  whole remote-runtime cache entry was dropped while the connection was still up,
  so the next borrow built a _second_ `remote.Runtime` on it, re-registered the
  daemon-notification handlers and silently lost a browser-initiated turn. Fixed
  at the producer (`agentre` `589a7452`); the spec now asserts the fixed shape —
  the desktop runs a **second** turn on the session before the browser writes to
  it, and answers the R10b decision with no turn of its own in flight.
- **The pool still idle-reaps that connection ~30 s after the last turn**, after
  which the runtime tears down. A desktop idle for longer than that stops
  receiving until its next turn; widening it would change the connection-lifetime
  contract for unrelated pool callers, so it is deliberately out of scope.
- **The desktop bridge port is 34217**, not the 34216 the agentre repo's own e2e
  suites use, so the two never reuse each other's app.

## Reports

Report rules — one directory per scenario, create `report.md` **before** the run,
evidence inline, the honesty clause — live in
[`docs/verification.md`](../docs/verification.md), which owns them. The template
is [`docs/references/verification-report-template.md`](../docs/references/verification-report-template.md).

```
e2e/scratch/<scenario>/
├── report.md
├── screenshots/        ← where `pnpm drive shot` writes
├── videos/
└── resources/
```
