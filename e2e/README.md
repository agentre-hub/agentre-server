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
pnpm install-browsers   # first time only: downloads chromium

pnpm smoke              # committed smoke suite (desktop + mobile)
pnpm scratch            # your throwaway checks under scratch/
```

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
docker compose up -d pg redis
make dev
cd e2e && pnpm scratch
```

Those belong in `scratch/`, not in the committed smoke suite — they are slow,
they need infrastructure, and they will be the first thing to turn flaky in CI.

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
