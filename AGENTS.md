# AGENTS.md

Agent guidance for `agentre-server`.

## What this is

AgentRe Server — SaaS backend. Accounts + RFC 8628 Device Flow.

Go 1.26 on the [cago](https://github.com/cago-frame/cago) framework, PostgreSQL 16 + Redis 7,
with a React 19 + Vite + Tailwind + shadcn frontend embedded into the binary via `//go:embed`.
Module path is the bare `agentre-server` (not a GitHub path — deliberate, it is not imported by anything).

Part of the `/Users/codfrm/Code/agentre` Go workspace. The sibling desktop app
(`agentre/`) is **not** a dependency: server code must never import it.
Workspace-wide facts live in [`../AGENTS.md`](../AGENTS.md).

## Read this before you touch anything

| When you are… | Read | What it owns |
| --- | --- | --- |
| Running anything, or adding a command | [docs/develop.md](docs/develop.md) | Commands, layout, the enforced rules and their exemptions, commit flow, migrations |
| Adding an endpoint / service / repository | [docs/architecture.md](docs/architecture.md) | Layering, dependency direction, "how to add an X" |
| Writing any test | [docs/testing.md](docs/testing.md) | What to write per layer, sqlmock vs mockgen, build tags, the guard tests |
| Confirming a change actually works | [docs/verification.md](docs/verification.md) | The twin e2e tracks, scratch workflow, report rules |
| Touching the frontend | [docs/design.md](docs/design.md) | Colour tokens, dark/light, responsive, i18n, the new-page recipe |
| Deploying, or changing the image/chart/workflow | [deploy/README.md](deploy/README.md) | Docker and Kubernetes deployment, chart values, etcd seeding, the Gitea pipeline |
| Adding a log line, metric or span | [docs/observability.md](docs/observability.md) | Log levels and fields, sensitive-field rules, metrics, traces |
| Editing docs | [docs/documentation.md](docs/documentation.md) | Who owns which fact, how docs are fact-checked |

## Non-negotiables

These are enforced mechanically. When a task conflicts with one, **stop and ask** — do not work around it.

1. **TDD: red → green → refactor.** No production code without a failing test first.
   For a bug, write the regression test and **watch it fail for the right reason** before fixing.
   If you cannot reproduce it, say so — do not change things speculatively.

2. **This repo has zero build tags. Do not add one.** `_test.go` is already excluded from
   `go build`, so a tag protects nothing and instead makes `go test ./...` skip the file
   while still printing green — `[no test files]` is indistinguishable from "no tests here".
   Test-only assets go in a package imported solely from `_test.go`;
   `internal/pkg/jwt/testkeys/isolation_test.go` asserts such a package stays out of the
   production binary. See [docs/testing.md](docs/testing.md#build-tags).

3. **One concept, one implementation.** Colours come from tokens, never literals
   (`no-restricted-syntax`). UI copy comes from `t()`, never literals (`i18next/no-literal-string`).
   Logs go through `logger.Ctx(ctx)`, never `fmt.Print`/`log.Print` (`forbidigo`).
   Each has a guard test; adding an exemption means writing the reason next to it.

4. **Credentials never reach the logs.** `internal/guards/observability_test.go` scans for it.
   Log an `_id` or a `_hash`, never the token itself.

5. **Dependencies flow one way**: `api/controller → service → repository → model/entity`.
   `internal/pkg/*` is cross-cutting and must never import service or repository.
   Service depends on repository **interfaces** only (mockgen).

6. **Never modify an existing migration.** Append a new patch migration to the end of
   `migrationList()`. Prefer native SQL for DDL.

7. **Do not touch files unrelated to your task.** No drive-by renames, reformatting, or
   dead-code cleanup — it buries the real change and breaks `git bisect`. Flag what you
   noticed instead of fixing it on the side.

## Architecture at a glance

```
cmd/server/main.go          component registration order (trace → metric → db → redis → cron → mux)
internal/
  api/                      request/response structs + router.go (route tree, middleware groups)
  controller/*_ctr/         thin: validate → call service → return
  service/*_svc/            business logic; interface + singleton + private impl
  repository/*_repo/        data access; interface + Register/accessor + db.Ctx(ctx)
  model/entity/*_entity/    rich entities — Check(ctx) / IsActive() live here, not in service
  middleware/               session auth, device JWT, CSRF, rate limit, RFC 8628 error fields
  pkg/                      cross-cutting: jwt, session, ratelimit, usercode, code (i18n errors)
  guards/                   repo-wide mechanical guard tests (no business logic)
  task/crontab/             scheduled cleanup
  web/                      embed.FS SPA mount, /v1 passthrough
migrations/                 gormigrate; append-only
frontend/                   React 19 + Vite + Tailwind + shadcn
e2e/                        twin tracks: committed smoke + gitignored scratch
```

Auth has three shapes, and which one a route uses is visible in `internal/api/router.go`:
public, browser session (+ CSRF), device JWT, or `SessionOrDeviceAuth` for either.

## Conventions

- Commits: **gitmoji** (`✨ scope: summary`). Comments and commit messages in Chinese; docs in English.
- Linters: golangci-lint v2 (Go), ESLint flat config (frontend). Both run in `make lint` and in CI.
- Mocks: `//go:generate mockgen`, regenerate with `make mock`.
- Config never lands on disk from code: `configs/config.example.yaml` is the template,
  `configs/config.yaml` is gitignored, secrets come from env via `bootstrap.LoadServerConfig`.

## Related specs

- Foundation design: [`../agentre-hub/docs/superpowers/specs/2026-06-16-hub-foundation-design.md`](../agentre-hub/docs/superpowers/specs/2026-06-16-hub-foundation-design.md)
