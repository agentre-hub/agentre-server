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
| Public | — | healthz, GitHub OAuth authorize/callback, `/v1/keys` |
| Device flow | `AttachOAuthErrorFields()` (+ `AuthorizePerIPLimit`) | `authorize`, `token`, `refresh` |
| Browser session | `SessionAuth()` + `CSRF()` | logout, device pending/approve/deny |
| Either credential | `SessionOrDeviceAuth(signer)` — enforces CSRF on the session branch for unsafe methods | `/v1/auth/me`, `/v1/devices`, `/v1/oauth/token/revoke` |
| Device JWT | `DeviceJWT(signer)` | `/v1/devices/revocations`, `/v1/relay/daemon`, `/v1/relay/client` |

Cookie-authenticated writes always clear CSRF, whichever group they sit in: a
Bearer caller carries no cookie and is exempt, a session caller is not.

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
