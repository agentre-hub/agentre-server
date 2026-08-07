# Testing

## The cycle

Red → green → refactor. No production code without a failing test first. For a bug:
write the regression test, **run it and watch it fail for the right reason**, then fix.
A test that was never seen red proves nothing — it may be asserting something that was
already true.

If you cannot reproduce a reported bug, say so explicitly rather than changing code
speculatively. And do not add a guard in the consumer to paper over a producer bug.

## What to write, per layer

| Layer | Tool | Rule |
| --- | --- | --- |
| Entity | plain table tests | Business rules (`Check`, `IsActive`, state transitions) live here, so test them here |
| Repository | **sqlmock** | **Never start a real PostgreSQL.** `internal/testutils.Database(t)` gives you a postgres-dialect sqlmock through ctx |
| Service | **mockgen** | Inject repo mocks via `xxx_repo.RegisterXxx(mock)`. Never touch a database |
| Controller | `muxtest.TestMux` | Build the route tree, `testMux.Do(ctx, req, resp)` |
| Migrations | **nothing** for the DDL; sqlmock for the runner around it | `migrationList()` is deliberately untested — see below |
| Browser | `e2e/` | See [verification.md](verification.md) |

Repository tests are the rule people break first. sqlmock keeps them fast and hermetic;
a real database makes them order-dependent and slow, and they start failing for reasons
that have nothing to do with the code.

There is no cross-layer tier. A test that stands up its own `gin.New()` and hand-writes
the `code`/`msg`/`data` envelope is not testing the wiring — it is testing a second
implementation of it, one that stays green while the real `internal/api/router.go` breaks.
`internal/integration/` was exactly that and has been removed. Test each layer at its own
seam, use `muxtest.TestMux` when you need the real route tree, and leave genuine
end-to-end wiring to `e2e/`, which runs the real binary.

## Build tags

**Do not put a build tag on a test file.** `_test.go` is already excluded from `go build`,
so a tag protects nothing from shipping. What it does do is make `go test ./...` skip the
file — and print `[no test files]`, which reads exactly like "this package has no tests".
The suite stays green while the tests do not run, and nothing distinguishes a tagged-out
package from one that was never tested.

If you have a test-only asset that genuinely must not ship (a fixture private key, say),
put it in its own package and import it **only from `_test.go` files**. The Go linker
then keeps it out of the binary, because nothing reachable from `main` references it.
Assert that rather than trusting it:

```go
// internal/pkg/jwt/testkeys/isolation_test.go
out, _ := exec.Command("go", "list", "-deps", "agentre-server/cmd/server").Output()
// ...fail if the testkeys package appears in the dependency graph
```

That is strictly stronger than a build tag: it also catches production code importing
the package, which is the path by which a key would actually leak.

### There are zero build tags

`git grep '//go:build'` returns nothing, and it should stay that way. Anything that seems
to need a tag is either (a) a test-only asset, which the package-isolation trick above
handles, or (b) a test needing external infrastructure — which gets its **own entry point**
(`make test-e2e`, or a scratch script per [verification.md](verification.md)), never a tag.
A target you did not run is obvious; a tagged-out test is invisible.

## Migrations are deliberately untested

There is no automated check that `migrations/migrationList()` runs cleanly against a real
PostgreSQL — that would mean a Docker dependency, which this suite deliberately avoids.

**Know what that costs you.** `cmd/server/main.go` runs `migrations.RunMigrations` at
startup, so a migration that is valid Go but invalid SQL — wrong type, bad constraint,
an ordering dependency on a table that does not exist yet — is not caught by anything
here. sqlmock repository tests never execute DDL. The first thing that executes your
migration for real is the server booting, and if it fails **the server does not start**.

So when you touch `migrations/`, verify it by hand before merging:

```bash
make dev                       # migrations run at startup against db.dsn; watch for errors
psql "<that same dsn>" -c '\dt'   # then read the tables back directly
```

Write that check up under `e2e/scratch/` per [verification.md](verification.md) — for
migrations the evidence is the table list, not a screenshot.

**What is untested is the DDL, not the runner.** `migrations/migrations_test.go` does use
sqlmock, on the advisory-lock wrapper `withMigrationLock` that serialises concurrently
starting replicas — it asserts the `pg_try_advisory_lock` retry, that the migration func
only runs once the lock is held, and that `pg_advisory_unlock` follows. That is a
statement-sequence assertion, so it stays hermetic; it says nothing about whether any
migration in `migrationList()` is valid SQL.

## The jsdom environment

Frontend unit tests run under jsdom, which is missing things a browser has. Fill the gap
in **`frontend/src/test/setup.ts`** (wired as vitest's `setupFiles`) — never by mocking
the module that happens to touch it.

The distinction matters. `vi.mock('@/lib/theme')` in each test file that renders the shell
would make those files pass, but they would then be exercising a hand-written stand-in
instead of `ThemeProvider` + `useTheme` — the wiring the test is nominally about stops
being covered, in every file, silently. A shim in the setup file leaves the component
under test untouched.

Two shims live there today, both installed only when the runtime lacks them:

- **`localStorage` / `sessionStorage`.** Node ≥ 22 puts a built-in `localStorage` getter
  on `globalThis` that resolves to `undefined` without `--localstorage-file`, *and* it
  shadows jsdom's own implementation, so `lib/theme.tsx`'s `readStored()` throws.
- **`matchMedia`.** jsdom has never implemented it; `ThemeProvider` reads it for the
  system colour scheme.

Anything that needs real layout — a card overflowing a phone viewport, a flex row that
will not shrink — cannot be tested here at all. jsdom computes no layout. That belongs
in `e2e/`, under the `mobile-chromium` project.

## Guard tests

Some tests assert that a **convention is still enforced** rather than that code works.
They live next to what they guard, plus `internal/guards/` for repo-wide ones.

| Guard | Asserts |
| --- | --- |
| `internal/guards/observability_test.go` | `forbidigo` is still in `.golangci.yml` with both patterns; no credentials in log fields |
| `internal/pkg/jwt/testkeys/isolation_test.go` | Test keys are not in `cmd/server`'s dependency graph |
| `frontend/src/__tests__/eslint-guardrails.test.ts` | Colour-token and i18n rules fire, at error severity, over `src/` |
| `frontend/src/__tests__/error-code-contract.test.ts` | `lib/errorCodes.ts` still matches the Device Flow `iota` block in `internal/pkg/code/code.go` |
| `frontend/src/__tests__/user-code-contract.test.ts` | `lib/userCode.ts`'s alphabet and length still match `internal/pkg/usercode` |
| `frontend/src/__tests__/login-error-contract.test.ts` | `Login.tsx`'s `KNOWN_ERRORS` still matches the `/login?err=` values `auth_ctr` redirects with, and each has copy in both locales |
| `frontend/src/i18n/__tests__/locale-parity.test.ts` | Every locale has exactly the same keys |
| `frontend/src/i18n/__tests__/language-switch.test.ts` | Switching language actually changes the copy |

Two properties make these worth having, and both are easy to get wrong:

1. **They load the project's real config**, not a copy inlined in the test. A guard that
   builds its own ESLint config can pass while the rule is not wired into the project at all.
2. **They assert both directions.** A violating sample must be reported *and* a compliant
   sample must not. Only checking the first lets a rule that flags everything pass.

When you add a lint rule, add its guard in the same change, then **verify the guard fails**:
comment the rule out of the config, watch it go red, put it back. An unverified guard is
worth the same as no guard.

## i18n tests are not optional

`locale-parity` catches a missing key. It cannot catch the more dangerous failure:
i18next resolving a language to a *different* one and silently serving the fallback.
That is what `language-switch.test.ts` is for — it asserts on `resolvedLanguage` and on
the actual return value of `t()`, because `i18n.language` can say `zh-CN` while every
string on screen is still English. See [design.md](design.md#i18n).

## Running

```bash
make test                                        # backend + frontend, the default gate
go test -race -run TestExchangeToken ./internal/service/device_svc/...
cd frontend && pnpm test -- src/i18n             # narrow vitest
cd frontend && pnpm exec vitest                  # watch mode
make test-e2e                                    # see verification.md
```

`-race` is on by default in `make test` and should stay on — the device-flow state machine
and the session store are both concurrently accessed.
