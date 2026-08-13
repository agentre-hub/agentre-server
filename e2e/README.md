# E2E and local real verification

This directory owns the E2E harness: explicit config, ports, real-dependency
boundaries, run isolation, cleanup, and troubleshooting. Report workflow and
verdict rules live in [`docs/verification.md`](../docs/verification.md).

## Entry points

| Entry point                  | Committed                                          | Purpose                                                                | Dependencies                                                                       |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `make e2e` (repository root) | Yes; the sole automated E2E route and the CI route | Run the six-category baseline smoke in desktop and mobile Chromium     | Formal embedded Go server, real MySQL and Redis                                    |
| `pnpm serve` + `pnpm drive`  | Harness only; evidence is local                    | Inspect the same real target one action at a time                      | Same build, migration, health, seed, and cleanup components as the automated route |
| `pnpm scratch`               | No; `scratch/` is gitignored                       | Replay a one-off sequence, concurrency case, or timing-sensitive check | A real E2E target already started by the developer                                 |

Install the E2E package before using the local commands:

```bash
cd e2e
pnpm install

pnpm serve              # hold a seeded real environment open until Ctrl-C
pnpm drive up           # open the signed-in browser from the serve handoff
pnpm scratch            # run gitignored specs under scratch/
```

From the repository root, automated verification is always:

```bash
make e2e
```

Do not replace that target with a handwritten CI command. It installs the
browser dependencies, runs the runner guards, then runs the committed smoke once
for desktop Chromium and once for mobile Chromium.

## Explicit E2E configuration

Copy the tracked placeholder template, generate local keys, and edit only the
gitignored copy:

```bash
cp configs/config.e2e.example.yaml configs/config.e2e.yaml
mkdir -p runtime/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out runtime/keys/e2e-jwt.key
openssl pkey -in runtime/keys/e2e-jwt.key -pubout -out runtime/keys/e2e-jwt.pub
# Set the absolute key paths and your dedicated E2E MySQL/Redis addresses in
# configs/config.e2e.yaml, then run from the repository root:
make e2e
```

The runner defaults to `configs/config.e2e.yaml`; `E2E_CONFIG=/absolute/path`
selects another explicit file. The file must declare `source: file`, use exactly
one loopback HTTP address, make `server.public_url` match it, and enable insecure
cookies for that loopback origin. The formal server is started as:

```text
bin/server --config <explicit-path>
```

The server itself still defaults to `configs/config.yaml` when `--config` is not
passed, so local development and deployment remain compatible. An explicit path
that is missing, unreadable, or invalid fails without falling back to the default.

The runner parses the MySQL DSN before building or starting anything. The
database name must contain an `e2e` marker. It never creates, drops, renames, or
truncates that database. Startup output contains only a redacted host/port,
database name, and Redis address/database; it does not print the DSN credentials
or Redis password.

## What the committed smoke covers

The suite deliberately stays at six baseline categories:

1. formal server health against real MySQL and Redis;
2. logged-out authentication and redirect behaviour;
3. a real signed-in session and the empty console state;
4. complete RFC 8628 device authorization, CSRF, persistence, token exchange,
   and single-consumption behaviour;
5. core-page layout without horizontal overflow on desktop and mobile;
6. embedded SPA fallback plus missing-asset HTTP 404 behaviour.

It does **not** cover agentred, the Wails desktop app, relay/WebSocket delivery,
multi-end synchronization, GitHub OAuth against GitHub, load/performance,
browser matrices beyond Chromium, or destructive database lifecycle testing.
Those require a separately scoped verification round; no compatibility alias for
a removed full-chain route is kept here.

## Data isolation and cleanup

Every invocation creates a unique run ID and one isolated user. The fixture tool
seeds only the account/session state needed by the smoke or hand-driven run. API
calls go directly to the formal server; there are no route mocks.

Cleanup is run-scoped and follows foreign-key order. It deletes only the current
run's device tokens, device flows, synchronization data, follows, devices,
identity, user, Redis session, and the authorize rate-limit key created with the
run's reserved fixture IP. It never issues `DROP
DATABASE`, `TRUNCATE`, `FLUSHDB`, or `FLUSHALL`, and concurrent runs do not delete
each other's data.

After deletion, the fixture tool independently counts residue for the current
run. Any remaining user, flow, device, token, or session makes the command fail;
diagnostics report only residue types and counts, not cookies, tokens, or
personal data.

## Driving by hand (`pnpm serve` + `pnpm drive`)

`pnpm serve` uses the same formal build, explicit config, migrations, health
check, seed, and cleanup code as `make e2e`, but stops before running the committed
spec. It writes `e2e/.drive/serve-env.json`, which lets `pnpm drive up` open the
approved origin already signed in.

```bash
cd e2e
pnpm serve

# In another shell:
export AGENTRE_VERIFY_SCENARIO=2026-08-13-console
pnpm drive up
pnpm drive snapshot
pnpm drive click "testid=nav-devices"
pnpm drive text "main"
pnpm drive sql "select status from device_flow_codes where user_code = '<code>'"
pnpm drive shot 01-devices
pnpm drive viewport 390x844
pnpm drive logs 40
pnpm drive down
```

Start with `snapshot`; it lists visible interactive elements and their selectors.
Each later invocation performs one action and appends its result immediately to
`scratch/<scenario>/logs/drive.log`.

The driver mechanically enforces these boundaries:

- only the origin approved by this run is driven;
- `drive sql` accepts only `SELECT`, `WITH`, `EXPLAIN`, and `SHOW`;
- screenshots stay under the current scenario and reject path traversal;
- the browser is headless unless `--headed` is requested.

On SIGINT or SIGTERM, `pnpm serve` removes the handoff, cleans the current run,
and stops the server. A later start first verifies a dead handoff's owned run ID
and completes run-scoped stale cleanup, then removes the handoff; malformed or
unowned handoffs are preserved for manual inspection. It refuses to take over an
environment whose health endpoint is still live.

## Scratch specs

Use `pnpm scratch` only when the sequence must be replayed or timing/concurrency
is the contract. By default it reads the live `pnpm serve` handoff. A manually
provided `E2E_BASE_URL` must still be a loopback HTTP origin.

Everything under `e2e/scratch/` is gitignored and CI does not collect it. Create
`report.md` before running and follow
[`docs/verification.md`](../docs/verification.md); scratch scripts, screenshots,
traces, and reports are local evidence, not part of `make e2e`.

## Runtime files and sensitive information

Per-run server logs, fixture binaries, seed handoffs, and cleanup results live in
`e2e/runtime/<run-id>/`; the drive handoff lives in `e2e/.drive/`; Playwright
failure evidence lives in its gitignored result directories. These files may
contain a session cookie, CSRF token, DSN, or other transient credentials and
must never be committed.

Console and startup-failure diagnostics redact DSN credentials and Redis
passwords. Before copying evidence into a report or CI artifact, redact again:
private keys, complete DSNs, database credentials, Redis passwords, session
cookies, CSRF tokens, access tokens, refresh tokens, and real personal data must
not appear in filenames, reports, screenshots, traces, or committed fixtures.

## CI

The CI E2E job starts job-local MySQL 9.7.2 and Redis 7 containers, waits for
them, generates a temporary RSA key pair and `configs/config.e2e.yaml`, then
calls only `make e2e`. It uses no developer config, remote E2E environment, or
internal-network secret.

Failure artifacts are copied to a separate redacted directory before upload.
Only screenshots/videos and sanitized per-run server logs are retained; traces,
raw handoffs, and raw logs are never uploaded. The job always runs
`docker compose down -v --remove-orphans`, so containers and
volumes are destroyed after success or failure; concurrent jobs do not share a
persistent database.

## Troubleshooting

- `cannot read explicit E2E config`: create the gitignored config or correct
  `E2E_CONFIG`; there is no fallback.
- `must declare source: file`: do not point the harness at an etcd bootstrap
  config; the runner must inspect the exact local values before touching data.
- `refusing non-E2E database`: use a dedicated database whose name contains an
  `e2e` marker. The runner will not create one for you.
- `E2E port ... is already in use`: stop the other process or choose another
  loopback address consistently in `http.address` and `server.public_url`.
- startup/health failure: inspect the reported `e2e/runtime/<run-id>/server.log`;
  redact it before sharing.
- cleanup residue: inspect the residue types/counts in `cleanup.json`; do not
  bypass the failure or use a database-wide cleanup command.
