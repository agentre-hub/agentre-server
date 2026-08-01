# Developing

## Commands

Everything routes through the `Makefile` at the repo root. **The same command
runs locally and in CI** — CI calls these targets rather than spelling the tools
out again, so "green locally, red in CI" has one less way to happen.

```bash
make dev               # vite (:5174, proxies /v1 → :8443) + go run ./cmd/server, in parallel
make build             # frontend build → copy into internal/web/dist → go build → bin/server

make test              # THE default gate: test-backend + test-frontend
make test-backend      # go test -race ./...   (there are no build tags — see below)
make test-frontend     # cd frontend && pnpm test  (vitest)
make test-e2e          # cd e2e && pnpm smoke — desktop + mobile chromium
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
and only reach for a sub-target when iterating.

The repo has **no build tags at all**, so `make test` runs everything there is. See
[testing.md](testing.md#build-tags) for why that is load-bearing, and keep it that way.

## First run

```bash
cp configs/config.example.yaml configs/config.yaml   # gitignored runtime config
cp .env.example .env                                 # secrets
docker compose up -d pg redis                        # or point at your own
make dev
```

`e2e` has its own package and needs one extra step the first time:

```bash
cd e2e && pnpm install && pnpm install-browsers
```

## Layout

See the map in [`../AGENTS.md`](../AGENTS.md#architecture-at-a-glance); the
layering rules behind it are in [architecture.md](architecture.md).

## Rules that are actually enforced

Every rule below fails a build. Each has a guard test, because a rule that can be
silently unwired is not a rule — the guard is what proves it is still loaded, at
the right severity, over the right files.

| Rule | Enforced by | Guard test |
| --- | --- | --- |
| No `fmt.Print*` / `log.Print*` | `forbidigo` (`.golangci.yml`) | `internal/guards/observability_test.go` |
| No credentials in log fields | `internal/guards/observability_test.go` | (is itself the check) |
| Test keys never link into `bin/server` | `internal/pkg/jwt/testkeys/isolation_test.go` | (is itself the check) |
| No literal colours in ts/tsx | `no-restricted-syntax` (`frontend/eslint.config.js`) | `frontend/src/__tests__/eslint-guardrails.test.ts` |
| No literal UI copy | `i18next/no-literal-string` | same file |
| Locale files have identical keys | `frontend/src/i18n/__tests__/locale-parity.test.ts` | (is itself the check) |
| Language switching really switches | `frontend/src/i18n/__tests__/language-switch.test.ts` | (is itself the check) |
| Formatting | `prettier` — via `eslint-plugin-prettier` in `frontend/`, standalone in `e2e/` | (eslint reports it as `prettier/prettier`) |

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
- **`frontend/eslint.config.js`** — `tailwind.config.ts` and `eslint-rules/` may
  contain literal colours (they define the tokens). Test files may contain
  literals of both kinds, because they construct the violating samples.

Adding an exemption means editing one of those two files and writing why.
If you cannot write a reason, the code is what needs changing.

## Migrations

Append-only. `migrations/migrations.go` holds `migrationList()`; new entries go at
the **end**, and existing entries are never edited — someone's database has already
run them. To correct an earlier migration, add a patch migration. Prefer native SQL
for DDL.

**Nothing tests migrations automatically.** They execute at server startup, so a bad one
means the service will not boot — and no test in this repo will tell you first. Verify by
hand before merging anything under `migrations/`; see
[testing.md](testing.md#migrations-are-deliberately-untested).

## Configuration

- `configs/config.example.yaml` is the committed template.
- `configs/config.yaml` is **gitignored** — it is the runtime file you copy and edit.
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

CI (`.github/workflows/ci.yml`) runs `lint`, `test`, `e2e` and `build` on every push to
`main` and every pull request. All four must pass.
