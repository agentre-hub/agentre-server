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
| Repository | **sqlmock** | **Never start a real MySQL.** `internal/testutils.Database(t)` gives you a mysql-dialect sqlmock through ctx |
| Service | **mockgen**, plus sqlmock for transaction owners | Inject repo mocks via `xxx_repo.RegisterXxx(mock)`; a service may use `db.Ctx(...).Transaction` to orchestrate repository calls |
| Controller | `muxtest.TestMux` | Build the route tree, `testMux.Do(ctx, req, resp)` |
| Migrations | sqlmock for the runner; real MySQL for DDL | Do not duplicate schema text in unit tests — see below |
| Browser | `e2e/` | See [verification.md](verification.md) |

Repository tests are the rule people break first. sqlmock keeps them fast and hermetic;
a real database makes them order-dependent and slow, and they start failing for reasons
that have nothing to do with the code.

**Write expectations in the dialect the driver actually speaks** — backtick-quoted
identifiers and `?` placeholders. `testutils.Database` deliberately has no dialect
translation layer: rewriting the emitted SQL into some other dialect before matching means
the test pins a string the database will never receive, and the next reader concludes the
service talks to a different engine than it does. If an expectation looks wrong against
MySQL, the expectation is wrong.

There is no cross-layer tier. A test that stands up its own `gin.New()` and hand-writes
the `code`/`msg`/`data` envelope is not testing the wiring — it is testing a second
implementation of it, one that stays green while the real `internal/api/router.go` breaks.
`internal/integration/` was exactly that and has been removed. Test each layer at its own
seam, use `muxtest.TestMux` when you need the real route tree, and leave genuine
end-to-end wiring to `make e2e`, which runs the formal server against real MySQL
and Redis without API route mocks. Repository unit tests still use sqlmock and
service unit tests still use mockgen; see [`../e2e/README.md`](../e2e/README.md).

## Assert behaviour, not implementation text

Do not write unit tests that read source, generated SQL, configuration text or another
implementation artifact and then use `Contains`, regular expressions or snapshots to
repeat facts already written there. In particular, do not duplicate migration table names,
columns, types, defaults, indexes, collations, migration IDs or migration counts in a test.
Those assertions do not exercise MySQL or user-visible behaviour; they only create a second
copy of the implementation that must be edited in lockstep with the first.

This rule is about the **subject under test**, not a blanket ban on comparing strings.
Exact string assertions remain appropriate when the string is itself an observable contract,
such as an API error code, serialized wire value, localization result, generated command or
log field required by a specification. Sqlmock may likewise match SQL emitted by repository
code when that is the package's database interaction seam. What is not useful is inspecting
the migration or source text itself and asserting that it contains another copy of the same
schema or implementation choice.

Test the owner at a real seam instead: pure business rules with inputs and outputs,
repositories through their emitted database operations, controllers through the mux, and
migration DDL by starting the server against real MySQL and reading the resulting schema
back. Tests for migration orchestration may use sqlmock to cover locking, ordering, error
propagation and cleanup because those are executable control-flow behaviours independent of
the DDL text.

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
out, _ := exec.Command("go", "list", "-deps", "github.com/agentre-hub/agentre-server/cmd/server").Output()
// ...fail if the testkeys package appears in the dependency graph
```

That is strictly stronger than a build tag: it also catches production code importing
the package, which is the path by which a key would actually leak.

### There are zero build tags

`git grep '//go:build'` returns nothing, and it should stay that way. Anything that seems
to need a tag is either (a) a test-only asset, which the package-isolation trick above
handles, or (b) a test needing external infrastructure — which gets its **own entry point**
(`make e2e`, or a hand-driven run per [verification.md](verification.md)), never a tag.
A target you did not run is obvious; a tagged-out test is invisible.

## Migration compatibility is not automated

There is no focused migration test against representative existing rows. `make e2e`
executes startup migrations on a real dedicated E2E database, but that baseline is not
upgrade-compatibility coverage.

Per [Assert behaviour, not implementation text](#assert-behaviour-not-implementation-text),
there are deliberately no unit tests that parse migration DDL or duplicate schema details
as string assertions. `migrations/migrations_test.go` covers only the named-lock runner.
It does not make MySQL parse the DDL or exercise upgrades from representative historical
rows. A green baseline E2E database therefore does not prove upgrade safety.

So when you touch `migrations/`, verify it by hand before merging:

```bash
make dev                       # migrations run at startup against db.dsn; watch for errors
mysql --host <host> --user <user> --password <database> -e 'SHOW TABLES' # read tables back directly
```

Write that check up under `e2e/scratch/<scenario>/` per [verification.md](verification.md) —
for migrations the evidence is the table list, not a screenshot, and nothing needs authoring.

`migrations/migrations_test.go` covers the named-lock wrapper `withMigrationLock`: the
`GET_LOCK` retry, execution only after acquisition, `RELEASE_LOCK`, and `NULL` handling.
Those hermetic assertions still say nothing about whether MySQL accepts a migration or
whether it preserves existing production-shaped data.

## The jsdom environment

Frontend unit tests run under jsdom, which is missing things a browser has. Fill the gap
in **`frontend/src/test/setup.ts`** (wired as vitest's `setupFiles`) — never by mocking
the module that happens to touch it.

The distinction matters. Mocking the theme exports from `@agentre-hub/agentre-ui` in each test file that renders the shell
would make those files pass, but they would then be exercising a hand-written stand-in
instead of `ThemeProvider` + `useTheme` — the wiring the test is nominally about stops
being covered, in every file, silently. A shim in the setup file leaves the component
under test untouched.

Four shims live there today, all installed only when the runtime lacks them:

- **`localStorage` / `sessionStorage`.** Node ≥ 22 puts a built-in `localStorage` getter
  on `globalThis` that resolves to `undefined` without `--localstorage-file`, *and* it
  shadows jsdom's own implementation, so the shared `ThemeProvider` fails when it reads the stored choice.
- **`matchMedia`.** jsdom has never implemented it; `ThemeProvider` reads it for the
  system colour scheme.
- **`scrollIntoView`.** jsdom does not implement it; Radix Select uses it to bring the
  selected item into view when the menu opens.
- **`ResizeObserver`.** jsdom does not implement it; the transcript virtualizer uses it
  to measure the viewport and row heights.

Anything that needs real layout — a card overflowing a phone viewport, a flex row that
will not shrink — cannot be tested here at all. jsdom computes no layout. That belongs
in `e2e/`, under the `mobile-chromium` project.

## Guard tests

Some tests assert that a **convention is still enforced** rather than that code works.
They live next to what they guard.

| Guard | Asserts |
| --- | --- |
| `internal/pkg/jwt/testkeys/isolation_test.go` | Test keys are not in `cmd/server`'s dependency graph |
| `internal/api/http_golden_test.go` | The committed `/v1/sync/*` and `/v1/engine/*` response samples still match what the real server emits |
| `frontend/src/__tests__/eslint-guardrails.test.ts` | Colour-token, native-control, secure-context, Alert-slot and i18n rules fire, at error severity, over `src/` |
| `frontend/src/__tests__/error-code-contract.test.ts` | `lib/errorCodes.ts` still matches the Device Flow `iota` block in `internal/pkg/code/code.go` |
| `frontend/src/__tests__/user-code-contract.test.ts` | `lib/userCode.ts`'s alphabet and length still match `internal/pkg/usercode` |
| `frontend/src/__tests__/login-error-contract.test.ts` | `Login.tsx`'s `KNOWN_ERRORS` still matches the `/login?err=` values `auth_ctr` redirects with, and each has copy in both locales |
| `frontend/src/i18n/__tests__/locale-parity.test.ts` | Every locale has exactly the same keys |
| `frontend/src/i18n/__tests__/locale-modules.test.ts` | Every per-module locale file is wired into its language bundle, under the key its filename names |
| `frontend/src/i18n/__tests__/language-switch.test.ts` | Switching language actually changes the copy |

Two properties make these worth having, and both are easy to get wrong:

1. **They load the project's real config**, not a copy inlined in the test. A guard that
   builds its own ESLint config can pass while the rule is not wired into the project at all.
2. **They assert both directions.** A violating sample must be reported *and* a compliant
   sample must not. Only checking the first lets a rule that flags everything pass.

When adding a frontend lint guard, **verify the guard fails**: comment the rule out of
the config, watch it go red, then put it back. An unverified guard is worth the same as
no guard.

### The HTTP contract samples

`internal/api/` is the truth for the HTTP contract, and the consumer is Go in *another*
repository — the desktop app hand-writes a mirror of these structs in
`internal/service/server_svc/`, so there is no package to publish it through.
`internal/api/http_golden_test.go` therefore pins this side of it: it drives the **real**
server (real route tree, middleware, controller and service; only the repositories are
mockgen mocks, with sqlmock behind the transaction) and records each response
byte-for-byte into `internal/api/testdata/http-samples/`. The set includes both `/v1/sync/*`
and the account-engine boundary: browser views must retain their masked credential shape,
while the Device JWT snapshot deliberately carries the caller's plaintext credential and
CLI overlay.

Regenerate after any change to a request/response struct:

```bash
HTTP_GOLDEN_WRITE=1 go test ./internal/api/ -run TestWriteHTTPGoldenSamples
```

Writing is gated on that variable, so `go test ./...` never writes to disk; the freshness
guard always runs and re-records into a temp directory to compare. The file's own comment
owns the rest — which endpoints are covered, and which values in a sample are contract
versus incidental to one recording.

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
make e2e                                         # see e2e/README.md
```

`-race` is on by default in `make test` and should stay on — the device-flow state machine
and the session store are both concurrently accessed.
