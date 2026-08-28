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
  mockgen injection possible. CRUD stays behind those interfaces; services that own an
  atomic workflow may orchestrate repository calls with `db.Ctx(...).Transaction` and
  `db.WithContextDB`.

Prefer domain-owned `<domain>_entity`, `<domain>_repo` and `<domain>_svc` packages. Do not
grow an unrelated domain merely to avoid adding the package that owns a new concept.

## Shared frontend packages

The Go dependency boundary above does not prohibit the frontend's two narrow,
cross-repository package dependencies:

- `@agentre-hub/agentre-ui` owns host-neutral components, view contracts, pure
  presentation helpers, shared copy and design tokens rendered by both the desktop and
  this web frontend.
- `@agentre-hub/agentre-wire` owns the generated TypeScript codec and contracts for the
  agentre ↔ agentred protocol. It remains separate from the React package.

Their source lives under `../agentre/frontend/packages/`; this frontend consumes built
packages pinned to immutable Git commits in `frontend/package.json`. Never point a
dependency at a branch or an unpushed local checkout: a standalone server build and CI
must resolve exactly the same source.

Before adding or substantially changing a component, view contract or pure presentation
helper, search this frontend and `../agentre/frontend/packages/agentre-ui`. A concept
rendered by both hosts has one implementation in the shared package. If a duplicate
already exists here, do not keep synchronizing it: first add and push the tested shared
implementation from the owning `agentre` repository, then update this repository's pin,
switch imports and delete the local component, types, styles, copy and tests that only
covered the duplicate.

This repository continues to own its account shell, React Router integration, HTTP and
CSRF/session clients, relay transport, data fetching and adapters. Those dependencies
enter shared components through props, ports or live-state hooks; they never enter the
shared package as `@/` imports or web/desktop conditionals. An optional capability with no
port renders no affordance. Code with merely a similar name but a different product
contract stays host-owned.

Shared behavior is tested in the owning package. This host separately tests its adapter,
data mapping and rendered integration, then runs the normal frontend lint, test and build
gates. The exact extraction and independent cross-repository commit order is summarized
in this repository's [`AGENTS.md`](../AGENTS.md#non-negotiables).

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

Services that need startup configuration expose `SetDefault(...)` (or another narrow
setter such as `user_svc.SetGate`) and are wired in `bootstrap.RegisterDefaults`.
`cmd/server/main.go` separately installs the configuration-free `engine_svc` default
before cago starts.

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

### Column collations are part of the contract

A collation decides what "equal" means, so on any column that a `WHERE`, a `JOIN` or a
unique key compares, it is a behavioural choice, not formatting. Pick it explicitly:

| Kind of value | Collation | Why |
| --- | --- | --- |
| Opaque identifiers, hashes, bearer credentials — `sync_id`, `*_fingerprint`, `session_id`, `device_code`, `refresh_token_hash`, `content_hash`, `provider_uid`, enum-ish `kind` | `utf8mb4_0900_bin` | Two values differing in any byte are two different things. Folding them merges distinct records and widens credential matching. |
| Identifiers a human types — `email`, `user_code` | `utf8mb4_0900_as_ci` | Case must not matter: one mailbox is one account, and a code typed lowercase must still match. |
| Text that is only stored and displayed — `display_name`, `name`, `platform`, `version`, `user_agent`, `ip`, `path`, `content_type` | *(table default `utf8mb4_0900_ai_ci`)* | Never compared, so the choice is inert. Leaving it unset marks it as "not load-bearing". |

Two traps, both of which produced real bugs in the PostgreSQL→MySQL move:

- **Only use the `utf8mb4_0900_*` family.** `utf8mb4_bin` and `utf8mb4_general_ci` are
  `PAD SPACE`, so they ignore trailing spaces — `'x'` equals `'x '`, and two `sync_id`s
  differing only by a trailing space collide on the unique key. Every `_0900_` collation is
  `NO PAD`, which is what PostgreSQL `text` does.
- **`ai_ci` is not "case-insensitive", it is also accent-insensitive.** As an email
  collation it makes `e@x.c` and `é@x.c` the same address. `as_ci` is the case-only tier.

Columns compared against each other must share a collation, or MySQL raises *illegal mix of
collations* at query time: `devices.fingerprint`, `sync_objects.agentred_fingerprint`,
`agent_session_saves.device_fingerprint` and `device_flow_codes.client_fingerprint` are one
such group; `users.email` and `user_identities.email` are another.

## Routing and auth shapes

`internal/api/router.go` is the one place the whole route tree is visible, and the
middleware groups are the authorization model:

| Group | Middleware | Used by |
| --- | --- | --- |
| Public | — (some endpoints add per-IP rate limits) | healthz, GitHub OAuth authorize/callback, passkey login, `/v1/keys` |
| Device flow | `AttachOAuthErrorFields()` (+ `AuthorizePerIPLimit`) | `authorize`, `token`, `refresh` |
| Browser session | `SessionAuth()` + `CSRF()` | logout and session management, passkey registration/management, device pending/approve/deny and relay ticket, `/v1/engine/*` browser CRUD, `/v1/stats/*` |
| Either credential | `SessionOrDeviceAuth(signer)` — enforces CSRF on the session branch for unsafe methods | `/v1/auth/me`, `/v1/devices`, `/v1/oauth/token/revoke`, workspace/organization/project APIs, agent-session and import APIs |
| Device JWT | `DeviceJWT(signer)` | `/v1/devices/revocations`, `/v1/relay/daemon`, `/v1/sync/*`, `/v1/engine/snapshot` |
| Relay client | `RelayClientJWT(signer)` | `/v1/relay/client`; accepts native Device JWTs and browser session-derived short-lived relay tickets |

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
task.MirrorResident
web.MountSPA
mux.HTTP(router)      → last; middleware registered by earlier components is collected here
```

Registering `trace` or `metric` after `mux.HTTP` means their middleware never attaches
and you get no spans and no metrics, with no error.

## Multi-instance safety

The deployment runs multiple replicas by default: `deploy/helm/values.yaml` sets
`autoscaling.enabled: true` with `minReplicas: 2`. "There is only one of me" is never a
safe assumption — it is false from the first install, not just under load.

**Shared vs process-local state.** MySQL and Redis are the only state visible to the
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
some other way. `device_repo.Upsert` writes with `INSERT … ON DUPLICATE KEY UPDATE` and then
reads the settled row back inside the same transaction (MySQL has no `RETURNING`), rather
than a find-then-create, so two exchanges for the same device converge on one row instead of
racing to a `uk_devices_user_fingerprint` duplicate-key 500.

**`ON DUPLICATE KEY UPDATE` only arbitrates when the table has exactly one unique key.**
MySQL fires it on whichever unique key the row collided with, and does not tell you which —
`clause.OnConflict{Columns: …}` is decorative in the MySQL dialect. `devices`,
`sync_account_seqs`, `sync_device_states`, `sync_avatars` and `agent_session_saves` each have a
single unique key, so the clause means what it reads like. `sync_objects` has two
(`uk_sync_objects_identity` and `uk_sync_objects_natural`), and there the clause would quietly rewrite *another account
row's* content under its own `sync_id`. `sync_repo.Save`
therefore splits into a version-guarded `UPDATE` plus a plain `INSERT`, and discriminates the
resulting `1062` by index name via `internal/pkg/dberr.IsDuplicateKey` — an identity
collision is a lost version race and is swallowed, a location collision is the R4b backstop
and must surface. Before adding an upsert, count the table's unique keys.

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
in-process guard. `migrations/migrations.go`'s `RunMigrations` takes a MySQL named
lock (`withMigrationLock`) on a connection obtained via `sqlDB.Conn(ctx)` before running
gormigrate, because named locks are session-scoped and a `*gorm.DB` call can otherwise
land on a different pooled connection than the one that acquired the lock. It polls
`GET_LOCK(name, 0)` — the zero-timeout form, which returns immediately — rather than letting
`GET_LOCK(name, <timeout>)` block, up to a 120s budget, so a replica that can't get the lock
fails loudly instead of hanging past its startup probe. `GET_LOCK` has three outcomes, not
two: `1` acquired, `0` held by someone else, and `NULL` when an error occurred; only `1`
counts as acquired, and the other two keep polling until the budget runs out.

## Activity statistics

The console's Overview is statistics-first, and its numbers come from a channel that is
**separate from the session mirror and off by default**.

**Why a second channel exists.** The mirror's scope is the account's *saved* conversations
(`agent_session_saves`), so anything a user never saved has no server-side trace at all.
Counting only what the mirror holds would understate every account without saying so. The
activity channel closes that gap by carrying counts only.

**What travels.** `agentre/internal/pkg/activityrollup` buckets a machine's sessions into
`(day × agent × backend × provider × model × project) → count`. Its `Activity` struct has
no field for a title, a path or a cwd, so conversation content cannot flow through this
channel — the boundary is structural, not procedural. `agent_activity_daily` mirrors that
shape: the columns that would hold content simply do not exist.

**A day is the day a conversation was *created*.** That choice is what makes the channel
converge. Bucketing by last activity moves a session from day to day as it is continued,
while the incremental lower bound advances past the days it left behind — one conversation
worked on for thirty days would be stored as thirty separate counts of one, and a one-shot
backfill would see only its last day, so backfill and incremental polling would produce two
histories that disagree. A creation day never moves, so a day's count is final once
written. The cost, stated plainly: the heatmap reads "conversations started that day", not
"conversations active that day", and a week-long conversation lights only its first cell.

A pull therefore **replaces** rather than merges: `DailyRepo.ReplaceBucketsFrom` deletes
`[since_day, ∞)` for that machine and writes the answer in one transaction. Merging is
only correct while the dimension combo is unchanged — a session that switches model
between rounds writes a new bucket and leaves the old one behind, and counts have nothing
to be checked against, so the day just silently gets bigger.

The `scope: "saved"` fallback still buckets by last activity: the mirrored row's
`createtime` is when *this server* first learned of the conversation, so one catch-up would
stamp a batch of old conversations with today and collapse the whole heatmap into one cell.
That path recomputes from the full list on every read rather than accumulating, so a moving
day costs it nothing.

**Direction.** The server pulls. `mirror_svc` dials out through the relay and calls
`RPC_METHOD_ACTIVITY_ROLLUP`; both peer kinds — the desktop app and `agentred` — register
the same method, so one implementation serves both. The rollup client is a one-method
interface (`mirror_svc.ActivityRollupClient`, consumed as `activity_svc.ActivityPeer`) and
is deliberately **not** part of `RelaySession`: the mirror's replies carry transcripts,
these carry counts, and the two must not become reachable from the same handle.

**The switch and the floor.** `user_settings.activity_stats_enabled` defaults to 0. While
it is off, `activity_svc.Pull` returns before sending a byte — asking a machine what it did
today *is* the reporting, whether or not the answer gets stored. Turning it on also writes
`activity_settings.activity_backfill_from`, the pull's lower-bound day: empty means "no
floor" (the opt-in dialog's *backfill history* checkbox), otherwise the day it was enabled.
Backfill is a stored floor rather than a one-off catch-up run precisely because a machine
that is offline at that moment would otherwise be skipped forever; the periodic pull
converges instead. Turning the switch off deletes the account's counts in the same
transaction that flips it, which is what the confirmation dialog promises.

**Day boundaries** are `char(10)` `"2006-01-02"` strings cut in the **server machine's**
timezone, end to end: the rollup request, the stored column, the heatmap cell key and the
next `since_day` are the same literal. One account's machines can sit in different
timezones, and a single day boundary is the only way its activity does not get split across
two cells.

**Two scopes, one shape.** `activity_svc.Overview` returns `OverviewView` either way:
`scope: "full"` reads the rollups, `scope: "saved"` aggregates the saved conversations in
Go when the switch is off. The frontend branches only on `scope` to decide whether to show
the narrower-coverage notice — it does not render two different pages.

**Multi-instance.** `crontab.PullActivityRollups` runs every 10 minutes under
`withPeriodLock`, so one replica per period walks the opted-in accounts, skips machines
that are offline or revoked, and dials the rest through a short-lived connection
(`mirror_svc.Supervisor.WithMachine` — no lease, nothing resident). One machine's failure
does not end the round; see [Multi-instance safety](#multi-instance-safety).

**What the console gets that the service does not compute.** `activity_svc.Overview`
deliberately omits `devices_online` / `devices_total` — device presence is the device
domain's fact, and `stats_ctr` joins it in. Per-machine backfill *progress* is not
reported at all: `ReportedThrough` answers "reported through which day", which cannot be
turned into "how many days remain" when the floor is "no floor". The frontend treats that
field as optional and simply omits the line.

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

**A table** — follow [develop.md](develop.md#migrations).

**An error code** — add to `internal/pkg/code/` (segment 30000+) with zh and en strings,
raise with `i18n.NewError(ctx, code.Xxx)`.

## Error handling

Two channels, deliberately separate:

- **OAuth / RFC 8628 errors** — `device_svc.OAuthError` → `device_ctr.oauthErrToHTTP` →
  `middleware.AttachOAuthErrorFields` injects the spec-mandated fields. Device-flow
  endpoints must return errors this way, or clients cannot interpret them.
- **Everything else** — `i18n.NewError(ctx, code.Xxx)`, which carries the localized message.
