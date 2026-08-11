# e2e — twin tracks

Two tracks. Different purposes, different destinations, **never mixed**.

|               | Smoke (`e2e/*.spec.ts`)             | Local verification (`e2e/scratch/`)          |
| ------------- | ----------------------------------- | -------------------------------------------- |
| Committed     | Yes                                 | **No** — the whole directory is gitignored   |
| Purpose       | Stop basic functionality regressing | "I just finished X — does it actually work?" |
| Lifetime      | Permanent                           | Disposable                                   |
| External deps | All mocked                          | May hit a real environment                   |
| Bar for entry | **Very high** — core flows only     | Low — write one whenever you want to check   |
| Output        | A green light in CI                 | `e2e/scratch/<task-name>/report.md`          |
| Config        | `playwright.config.ts`              | `playwright.scratch.config.ts`               |

## Running

```bash
cd e2e
pnpm install

pnpm smoke              # committed smoke suite (desktop + mobile)
pnpm scratch            # your throwaway checks under scratch/
```

Both scripts run `playwright install chromium` first. That costs ~2s once the
browser is there, and it is what stops the failure mode where bumping
`@playwright/test` leaves a stale build on disk and **every** spec goes red with
`Executable doesn't exist` — which reads like the app broke, not the browser.

From the repo root, `make test-e2e` runs the smoke track.

Both tracks run every spec against **two projects — `desktop-chromium` and
`mobile-chromium`**. Both are supported form factors, so a desktop-only pass
gives no signal about mobile layout. Narrow to one while iterating:

```bash
pnpm smoke --project=desktop-chromium
pnpm smoke -g "theme"
```

## Why two config files and not just .gitignore

`.gitignore` stops scratch being **committed**. It does nothing about scratch
being **picked up by a local run** — the files are sitting right there on disk.
So the smoke config `testIgnore`s `scratch/**`, and the scratch config points
`testDir` at it. The pair is what keeps CI unable to see scratch while it stays
runnable locally. Change one and you get scratch in CI, or scratch that no
longer runs.

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

## What earns a place in the smoke track

Only: the app boots, routing and auth redirects, core device-flow UI, theme and
language switching, no horizontal overflow on mobile. That is roughly the whole
list — the suite should stay seconds long.

Everything else goes to `scratch/`. Promoting a scratch spec to smoke is a
separate, deliberate decision, not something that happens because it was handy.

## Needing a real backend

The smoke track runs against the vite dev server with the API mocked, so it needs
no PostgreSQL or Redis. Full-stack flows (real device flow, migrations, session
cookies) need both, plus the Go server:

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

**PostgreSQL and Redis come from `configs/config.yaml`** — the server loads it
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
e2e/scratch/<task-name>/
├── report.md
├── screenshots/
├── videos/
└── resources/
```
