# Developing

## Commands

The root `Makefile` owns local commands and aggregate gates. GitHub CI uses the
corresponding targets where practical; its backend lint action and the Gitea deploy
workflow keep their tool versions and arguments aligned with those targets.

```bash
make dev               # vite (:5174, proxies /v1 → :8443) + go run ./cmd/server, in parallel
make build             # frontend build → copy into internal/web/dist → go build → bin/server

make test              # THE default gate: test-backend + test-frontend
make test-backend      # go test -race ./...   (there are no build tags — see below)
make test-frontend     # cd frontend && pnpm test  (vitest)
make e2e               # formal server + real MySQL/Redis + desktop/mobile Chromium
make test-cover        # coverage.html

make lint              # lint-backend + lint-frontend + lint-e2e
make lint-backend      # golangci-lint v2
make lint-frontend     # cd frontend && pnpm lint  (eslint incl. prettier, --max-warnings 0)
make lint-e2e          # cd e2e && pnpm lint  (prettier --check)
make fmt               # prettier --write across frontend/ and e2e/

make mock              # go generate ./... (mockgen)
make docker            # docker build -t agentre/server:0.1
```

The split exists because there are two package managers: Go via the Makefile,
frontend via pnpm. `make test` and `make lint` are the aggregates — **use those**,
and only reach for a sub-target when iterating. `make e2e` is the sole automated
browser route; CI calls that same target. Harness details live in
[`../e2e/README.md`](../e2e/README.md).

The repo has **no build tags at all**, so `make test` runs everything there is. See
[testing.md](testing.md#build-tags) for why that is load-bearing, and keep it that way.

## First run

```bash
cp configs/config.example.yaml configs/config.yaml   # gitignored runtime config
cp .env.example .env                                 # secrets
# point db.dsn / redis.addr in configs/config.yaml at your own MySQL + Redis
make dev
```

`e2e` has its own package and a gitignored explicit config:

```bash
cd e2e && pnpm install
cd .. && cp configs/config.e2e.example.yaml configs/config.e2e.yaml
```

Point that copy at dedicated E2E MySQL/Redis and local JWT keys; see
[`../e2e/README.md`](../e2e/README.md).

## Layout

See the map in [`../AGENTS.md`](../AGENTS.md#architecture-at-a-glance); the
layering rules behind it are in [architecture.md](architecture.md).

## Rules that are actually enforced

Every rule below fails a build.

| Rule | Enforced by |
| --- | --- |
| No `fmt.Print*` / `log.Print*` | `forbidigo` (`.golangci.yml`) |
| Test keys never link into `bin/server` | `internal/pkg/jwt/testkeys/isolation_test.go` |
| No literal colours in ts/tsx | `no-restricted-syntax` (`frontend/eslint.config.js`) |
| No literal UI copy | `i18next/no-literal-string` |
| No direct `crypto.randomUUID` | `no-restricted-syntax` (`frontend/eslint-rules/secure-context.js`) |
| Locale files have identical keys | `frontend/src/i18n/__tests__/locale-parity.test.ts` |
| Language switching really switches | `frontend/src/i18n/__tests__/language-switch.test.ts` |
| Formatting | `prettier` — via `eslint-plugin-prettier` in `frontend/`, standalone in `e2e/` |

### Formatting

**Prettier defaults, with no config file** — deliberately matching the sibling `agentre`
repo, so moving between repos in this workspace does not mean changing formatting habits.
That means double quotes and an 80-column width. Do not add a `.prettierrc` here without
changing it there too.

In `frontend/`, prettier runs *through* ESLint (`eslint-plugin-prettier`, registered last so
it wins conflicts), so `make lint-frontend` covers both. `e2e/` has no ESLint, so it runs
prettier directly. `make fmt` fixes both in one go.

`.prettierignore` excludes `src/i18n/locales` — the locale JSON is diffed key-by-key in
review, and reflowing it makes those diffs unreadable.

### Exemptions

There is no `//nolint` culture here. Every exemption is declared in one place,
with its reason next to it:

- **`.golangci.yml` → `linters.exclusions.rules`** — `cmd/server/main.go` and
  `internal/bootstrap/cago.go` may use stdlib `log`, because cago's logger does
  not exist until `component.Core()` has run. That is the only window.
- **`frontend/eslint.config.js`** — `eslint-rules/` may contain literal colours
  (it lists the banned colour names). Test files may contain literals of both
  kinds, because they construct the violating samples.
  `src/lib/randomId.ts` may call `crypto.randomUUID`, because it owns the
  fallback for it: the deployment is served over plain http, which is not a
  secure context, and `crypto.randomUUID` does not exist there.

Adding an exemption means editing one of those two files and writing why.
If you cannot write a reason, the code is what needs changing.

## Migrations

Append-only. `migrations/migrations.go` holds `migrationList()`; new entries go at
the **end**, and existing entries are never edited — someone's database has already
run them. To correct an earlier migration, add a patch migration. Prefer native SQL
for DDL.

Sqlmock guard tests execute the migration functions and check DDL policy, but they do not
prove that MySQL accepts the DDL or that upgrades preserve representative historical data.
Verify migrations by hand before merging; see
[testing.md](testing.md#migration-compatibility-is-not-automated).

## Configuration

- `configs/config.example.yaml` is the committed template.
- `configs/config.yaml` is **gitignored** — it is the default runtime file you copy and edit.
- `--config <path>` selects an explicit file and fails without fallback when invalid.
- `configs/config.e2e.example.yaml` is the placeholder E2E template;
  `configs/config.e2e.yaml` is gitignored.
- Secrets come from environment variables, injected by `bootstrap.LoadServerConfig`
  (cago's config source has no env override, so this is done by hand there).
  `.env.example` lists them.

Never commit a real key, and never read config from disk anywhere but bootstrap.

## Commit flow

1. `make lint && make test` — both must be green.
2. Commit with **gitmoji**: `✨ device_svc: record client info for refresh tokens`.
   Scope is the package. Chinese commit messages, matching the existing history.
3. One concern per commit. Do not mix a refactor into a feature commit, and do not
   mix changes across sibling repos — they are independent git repositories.

CI (`.github/workflows/ci.yml`) runs backend and frontend lint as separate jobs,
backend and frontend tests as separate jobs, plus `e2e` (including its formatting
check) and `build`, on every push to `main` and every pull request. All six jobs must
pass.
