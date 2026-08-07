# Architecture

## Layers and dependency direction

```
api/ (request+response structs, router)
        │
        ▼
controller/*_ctr/     thin — validate, call service, return
        │
        ▼
service/*_svc/        business logic; depends on repository INTERFACES
        │
        ▼
repository/*_repo/    data access; db.Ctx(ctx)
        │
        ▼
model/entity/*_entity/   rich entities: Check(ctx), IsActive(), state transitions
```

Dependencies flow **downward only**. Two consequences that get violated first:

- `internal/pkg/*` is a cross-cutting layer (jwt, session, ratelimit, usercode, code).
  It may be imported by anything above it and must **never import service or repository**.
  If a `pkg` package needs business data, the dependency is backwards — pass the data in.
- Service depends on the repository **interface**, never the struct. That is what makes
  mockgen injection possible, and it is why every repo exposes `Register*`.

One domain gets one set of packages: `<domain>_entity` / `<domain>_repo` / `<domain>_svc`.
A new domain means new packages, not new methods on an existing one.

## The singleton + Register pattern

Repositories are swapped for mocks in tests, so they are addressed through a package-level
accessor rather than constructed at the call site:

```go
// internal/repository/user_repo/user.go
type UserRepo interface {
	Create(ctx context.Context, u *user_entity.User) error
	Find(ctx context.Context, id int64) (*user_entity.User, error)
}

var defaultUser UserRepo

func User() UserRepo          { return defaultUser }
func RegisterUser(i UserRepo) { defaultUser = i }
func NewUser() UserRepo       { return &userRepo{} }

type userRepo struct{}
```

`cmd/server/main.go` wires the real implementation once at startup
(`user_repo.RegisterUser(user_repo.NewUser())`); a test calls `RegisterUser` with a mock.

Services follow the same shape, minus `Register` where nothing needs to swap them:

```go
// internal/service/user_svc/user.go
type UserSvc interface {
	FindOrCreateFromGithub(ctx context.Context, p GithubProfile) (*user_entity.User, error)
}

type userSvc struct{}

var defaultUser = &userSvc{}

func User() UserSvc { return defaultUser }
```

Services that need startup configuration (`auth_svc`, `device_svc`, `oauth_svc`) expose
`SetDefault(...)` instead and are wired in `bootstrap.RegisterDefaults`.

## Rich entities

Business rules that concern **one entity** live on the entity, not in the service.
`Check(ctx)`, `IsActive()`, state-machine transitions — all entity methods. The service
orchestrates across entities and repositories; it does not re-implement their invariants.

Not suitable for an entity: anything crossing entities, or needing an external service.

## Database access

```go
db.Default()                  // the *gorm.DB
db.Ctx(ctx)                   // context-aware — picks up an in-flight transaction
db.WithContextDB(ctx, tx)     // put a transaction into ctx
db.RecordNotFound(err)        // not-found check
```

Repositories always use `db.Ctx(ctx)`, never `db.Default()` — that is what makes them
compose inside a transaction:

```go
err := db.Ctx(ctx).Transaction(func(tx *gorm.DB) error {
	ctx = db.WithContextDB(ctx, tx)   // subsequent db.Ctx(ctx) now use tx
	if err := user_repo.User().Create(ctx, u); err != nil {
		return err
	}
	return user_identity_repo.UserIdentity().Create(ctx, ident)
})
```

A repository that reaches for `db.Default()` silently escapes the transaction.

## Routing and auth shapes

`internal/api/router.go` is the one place the whole route tree is visible, and the
middleware groups are the authorization model:

| Group | Middleware | Used by |
| --- | --- | --- |
| Public | — | healthz, GitHub OAuth authorize/callback |
| Device flow | `AttachOAuthErrorFields()` (+ `AuthorizePerIPLimit`) | `authorize`, `token`, `refresh` |
| Browser session | `SessionAuth()` + `CSRF()` | logout, device pending/approve/deny |
| Either credential | `SessionOrDeviceAuth(signer)` | `/v1/auth/me` |
| Device JWT | `DeviceJWT(signer)` | `/v1/devices` |

Endpoints are declared as structs with `mux.Meta`, which carries path and method:

```go
// internal/api/healthz/healthz.go
type HealthzRequest struct {
	mux.Meta `path:"/v1/healthz" method:"GET"`
}
type HealthzResponse struct {
	Status string `json:"status"`
	DBPing bool   `json:"db_ping"`
	Redis  bool   `json:"redis"`
}
```

Controllers stay this thin — no business logic, no direct repository access:

```go
// internal/controller/healthz_ctr/healthz.go
func (h *Healthz) Healthz(ctx context.Context, _ *api.HealthzRequest) (*api.HealthzResponse, error) {
	resp := &api.HealthzResponse{Status: "ok"}
	// ...
	return resp, nil
}
```

## Startup order

`cmd/server/main.go` registers components in an order that matters:

```
component.Core()      → config, logger
trace.Trace           → must be early; later components check trace.Default() before wiring in
metric.Metrics        → registers gin middleware + GET /metrics
component.Database()
component.Redis()
RegisterDefaults      → needs Redis (session store)
cron.Cron()
RunMigrations
task.Task
web.MountSPA
mux.HTTP(router)      → last; middleware registered by earlier components is collected here
```

Registering `trace` or `metric` after `mux.HTTP` means their middleware never attaches
and you get no spans and no metrics, with no error.

## Multi-instance safety

The deployment runs multiple replicas by default: `deploy/helm/values.yaml` sets
`autoscaling.enabled: true` with `minReplicas: 2`. "There is only one of me" is never a
safe assumption — it is false from the first install, not just under load.

**Shared vs process-local state.** PostgreSQL and Redis are the only state visible to the
whole fleet. Anything else — a `sync.Mutex`, a package-level cache, cago's in-process
`cron.Cron()` schedule — lives in one replica's memory and is invisible to its siblings.
If something must happen exactly once, or must see what every replica has done, it has to
go through the database or Redis, not process memory.

**Check-then-write across replicas.** A read followed by a conditional write is not safe
once two replicas can run it concurrently: both can read the same "not yet done" state and
both proceed. Put the condition in the `UPDATE`'s `WHERE` clause instead, and check
`RowsAffected` to learn whether *this* call was the one that changed the row — don't just
check the returned error. See `internal/repository/device_flow_repo/device_flow.go`'s
`MarkConsumed` (`WHERE device_code=? AND consumed_at=0 AND denied_at=0`) and
`Approve`/`Deny`, and `internal/repository/device_token_repo/device_token.go`'s `Revoke`
(`WHERE id=? AND revoked_at=0`): all four return `(int64, error)` so the *service*, not the
repository, decides what a lost race means — `internal/service/device_svc/device.go`'s
`ExchangeToken`, `Refresh`, `Approve` and `Deny` each check `n != 1` and turn a lost race
into the right error for that call. The `WHERE` clause has to spell out *every* state that
makes the write wrong, not just the one the caller was racing: `MarkConsumed` carries
`denied_at=0` as well, because the entity check it backs up (`flow.IsDenied()`) runs before
the transaction and a "deny" committed in that gap would otherwise still hand the device a
token.

A write with no conditional `UPDATE` to hang the decision on needs the database to arbitrate
some other way. `device_repo.Upsert` is a single `INSERT … ON CONFLICT ("user_id",
"fingerprint") DO UPDATE`, not a find-then-create, so two exchanges for the same device
converge on one row instead of racing to a `uk_devices_user_fingerprint` duplicate-key 500.

Inside a transaction, put the conditional `UPDATE` **first**, before any write that depends
on winning: `ExchangeToken` marks the flow consumed before it touches `devices`, and
`Refresh` revokes the old token before it inserts the new one. A loser then writes nothing
at all, rather than emitting rows that only the rollback takes back out.

**Adding a scheduled task.** cago's cron (`cron.Cron()`, registered in
`cmd/server/main.go`) is an in-process `robfig/cron` with no leader election — every
replica runs every registered func on its own schedule. Wrap the job so only one replica's
run per period actually executes, following `internal/task/task.go`'s `withPeriodLock`:
`TryLockKey` for the period with a TTL a bit shorter than the cron period, and no matching
`Unlock`. cago's locker `UnlockKey` is an unconditional `DEL` that doesn't check ownership,
so unlocking after the TTL has already rolled over to another replica would delete *that*
replica's lock — TryLock-and-let-expire avoids that. A replica that loses the race returns
`nil`, not an error, so the N-1 non-winning replicas don't log spurious `cron error` noise.

**Startup one-shot work.** Work that must run exactly once across a concurrently-starting
fleet — migrations are the current example — needs a distributed lock, not just an
in-process guard. `migrations/migrations.go`'s `RunMigrations` takes a PostgreSQL advisory
lock (`withMigrationLock`) on a connection obtained via `sqlDB.Conn(ctx)` before running
gormigrate, because advisory locks are session-scoped and a `*gorm.DB` call can otherwise
land on a different pooled connection than the one that acquired the lock. It polls
`pg_try_advisory_lock` rather than blocking, up to a 120s budget, so a replica that can't
get the lock fails loudly instead of hanging past its startup probe.

## How to add an X

**An endpoint**
1. Request/response structs with `mux.Meta` in `internal/api/<domain>/`.
2. Write the failing test first ([testing.md](testing.md)).
3. Controller method in `internal/controller/<domain>_ctr/`.
4. Bind it into the right middleware group in `internal/api/router.go`.

**A service** — interface + `var defaultX = &xSvc{}` + accessor in
`internal/service/<domain>_svc/`. Needs startup config? Add `SetDefault` and wire it in
`bootstrap.RegisterDefaults`.

**A repository** — interface + `Register`/accessor/`New` + `//go:generate mockgen`,
then `make mock`, then register it in `cmd/server/main.go`.

**A table** — append a migration to the end of `migrationList()`; never edit an existing one.

**An error code** — add to `internal/pkg/code/` (segment 30000+) with zh and en strings,
raise with `i18n.NewError(ctx, code.Xxx)`.

## Error handling

Two channels, deliberately separate:

- **OAuth / RFC 8628 errors** — `device_svc.OAuthError` → `device_ctr.oauthErrToHTTP` →
  `middleware.AttachOAuthErrorFields` injects the spec-mandated fields. Device-flow
  endpoints must return errors this way, or clients cannot interpret them.
- **Everything else** — `i18n.NewError(ctx, code.Xxx)`, which carries the localized message.
