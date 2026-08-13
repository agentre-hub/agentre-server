# Verification

Tests prove the code does what you told it to. Verification answers a different question: **"I just finished X — does it actually work?"** This route owns the workflow and the report rules; the harness — configs, ports, hermetic guarantees, what earns a place in the smoke suite — is [`../e2e/README.md`](../e2e/README.md)'s.

## When to skip this route

Use targeted committed tests alone when they fully observe the changed logic ([testing.md](testing.md#the-cycle)). Use this route when real HTTP, database, session or cross-process wiring is needed, or when reproducing a runtime-only bug. It does not replace TDD: a reproduction confirms the bug is real and still owes the committed failing test.

Verification is not how the smoke suite grows. Promotion is a separate, deliberate decision — things dropped into smoke because they were handy are what make it slow and flaky, and once it is flaky people stop believing it ([`../e2e/README.md`](../e2e/README.md#what-earns-a-place-in-the-smoke-track)).

## Workflow

1. Run `make lint` and the targeted tests; run `make test` only when the blast radius is not confirmed local or a gate requires it.
2. Build/start the drivable target. Only the target starts here: MySQL and Redis come from the gitignored `configs/config.yaml` (`configs/config.example.yaml` is the template), so `db.dsn` and `redis.addr` decide what a run actually writes to — a service it does not configure is asked for, not arranged around.
3. Choose the cheapest form that observes the contract, and put everything it produces under gitignored `e2e/scratch/<scenario>/`:

   | To reach and observe the target | You author |
   |---|---|
   | an existing command or entry point suffices, and it neither depends on nor writes your own machine state | nothing — drive it yourself and read the oracle |
   | it needs a specific launch, isolated state or real-target configuration, and the observation is one-off | a launcher that stops at the target; drive it yourself |
   | the sequence must be replayed, or timing/concurrency is the contract | a full asserting spec |

   This project:

   | Change lands in | Reach it with | You author | Oracle |
   |---|---|---|---|
   | HTTP API, auth, device flow, session cookies | `go run ./cmd/server`, then `curl` against `:8443` | nothing | a read-only SQL query against `db.dsn`, or the server log |
   | a migration | the forward command against a database holding real existing rows | nothing | the same query before and after, side by side |
   | web UI rendering only — layout, copy, theme, anything reachable logged out | `make dev`, then `pnpm drive up --base http://127.0.0.1:5174` | nothing | the screenshot, in **both** form factors (`drive viewport`) |
   | web UI behind auth, or touching real data | `cd e2e && pnpm serve` — a seeded account, already signed in — then `pnpm drive up` ([`../e2e/README.md`](../e2e/README.md#driving-by-hand-pnpm-serve--pnpm-drive)) | nothing | `drive sql`, plus the screenshots and `logs/drive.log` the run wrote |
   | replay, timing, or both form factors at once | the scratch track | a full spec | the spec's assertions |
   | the desktop app and a browser on one agentred | `pnpm dual` ([`../e2e/README.md`](../e2e/README.md#the-dual-end-run-pnpm-dual--the-desktop-app-and-a-browser-on-one-agentred)) | per that suite | that suite's assertions |

   Two facts decide the rows. The smoke track mocks the API; a scratch run reaches the real backend by simply **not** calling the `mock*` helpers from `fixtures/app.ts` — mocking is opt-in, there is no global switch to turn off, so calling one is a deliberate substitution the verdict row names. And every spec runs against **both** `desktop-chromium` and `mobile-chromium`: a desktop-only pass gives no signal about mobile layout.

   Reuse the harness for isolation and the oracle, not its mocks. In every form one observation comes from a path the driven surface does not share — read the database or the logs directly. Asserting the UI says "approved" does not prove the row was written; a failed write behind a cheerful UI is the exact failure this catches.

4. Before running, create `report.md` from [references/verification-report-template.md](references/verification-report-template.md); update it as evidence arrives. A report reconstructed afterwards from memory records what you believe happened, which is the thing under question.
5. Record how the target was driven, exit codes where the form produces them, deciding runtime observations, gaps and shortest user reproduction steps. `drive` already appends every action and its outcome to `e2e/scratch/<scenario>/logs/drive.log` and writes screenshots into `screenshots/` — the report cites those, it does not restate them.

```bash
cd e2e && pnpm serve                             # seeded real environment, held open until Ctrl-C
export AGENTRE_VERIFY_SCENARIO=<slug>            # every drive call records into this scenario
pnpm drive up                                    # a browser that outlives each command, already signed in
pnpm drive snapshot                              # what is on screen, and how to address it
pnpm drive click "testid=nav-devices" && pnpm drive shot 01-devices
pnpm drive sql "select status from device_flow_codes where user_code = '<code>'"

go run ./cmd/server                              # real backend on :8443, for curl and the SQL oracle
cd e2e && E2E_SCRATCH_AUTOSTART=1 pnpm scratch   # the spec form: frontend on :5199, /v1 proxied to :8443
cd e2e && pnpm scratch --project=desktop-chromium -g "<title>"
```

**Drive it before you write a spec.** A spec only asserts what you thought of in advance, and a one-line change costs a whole cold run; driving shows you what the page actually looks like now. That distinction is not theoretical here — the previous console round asserted elements existed and shipped a UI that did not match the design (`docs/specs/2026-08-12-console-design-fidelity.md`). Write a spec when the sequence must be **replayed**, not to look at something once.

For acceptance against a spec, `<scenario>` is that spec's slug, so the evidence and the spec are findable from each other. Extract each requirement into one verdict row and evidence section. Verdict labels are `holds`, `does not hold`, `not observed`, and they live only in the verdict table.

For bug reproduction, state whether the reproduction asserts the expected behaviour (stays red until the fix lands) or the current buggy behaviour (green now, must be flipped when you fix it). An assertion whose polarity is undocumented becomes meaningless within a week. Choosing a form that authors nothing does not remove the committed failing test.

Never weaken an assertion, skip a failed step or describe red as green. If you could not verify part of it, say which part and why — an unverified claim presented as verified stops anyone else from checking. If you worked around something rather than fixing it, that goes in the report too. Obtain authorization before destructive or external side effects, and before substituting a mock for a real dependency; the verdict row then names what stood in and what it does not cover.

## What the harness enforces for you

These are mechanical, in [`../e2e/lib/drive-target.mjs`](../e2e/lib/drive-target.mjs) — not conventions you have to remember:

- **Only this run's own origin is ever driven.** Any other URL is refused, including another port on your own machine — most likely the `make dev` you are actually working in.
- **The oracle is read-only.** `drive sql` takes only `SELECT` / `WITH` / `EXPLAIN` / `SHOW`.
- **Evidence stays in its scenario directory**, so the report's relative links hold.
- **Nothing takes over your screen**: the browser is headless unless you ask for `--headed`.

The same driver, commands and `drive.log` exist in the desktop repo (`agentre/e2e/drive.mjs`). The repos share no code — deliberately, they are independent — but changing the workflow in one is a reason to look at the other.

## Maintaining this route

Harness facts are owned by [`../e2e/README.md`](../e2e/README.md). Follow [documentation.md](documentation.md) after path or harness changes. What this route still owns:

```bash
grep -n 'e2e/scratch' .gitignore                        # evidence stays local
grep -n 'testDir' e2e/playwright.scratch.config.ts      # the scratch config still targets it
grep -n 'scratch\|serve\|drive' e2e/package.json        # the run commands still exist
git ls-files --error-unmatch e2e/drive.mjs e2e/lib/drive-target.mjs   # the driver is committed
```
