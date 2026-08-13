# Verification

Tests prove the code does what you told it to. Verification answers a different question:
**"I just finished X — does it actually work?"** This document owns how you answer that,
and how you write down the answer.

The mechanics of the two tracks — configs, ports, hermetic guarantees, what earns a place
in the smoke suite — live in [`../e2e/README.md`](../e2e/README.md). This document owns the
**workflow and the report rules**.

## The two tracks

| | Smoke (`e2e/*.spec.ts`) | Scratch (`e2e/scratch/`) |
| --- | --- | --- |
| Committed | Yes, runs in CI | No — gitignored |
| Question | "Did anything basic break?" | "Does the thing I just built work?" |
| Lifetime | Permanent | Disposable |
| Bar | Very high | None — write one whenever |

**When in doubt, use scratch.** Promoting a scratch spec into the smoke suite is a separate,
deliberate decision. Things dropped into smoke because they were handy are what make a smoke
suite slow and flaky, and once it is flaky people stop believing it.

## Workflow

```bash
mkdir -p e2e/scratch/<task-name>
# write report.md FIRST — see below
cd e2e && pnpm scratch
```

`<task-name>` is a lowercase hyphenated slug. **Where you are verifying against an approved
spec, use that spec's slug**, so the evidence and the spec are findable from each other.

Needing a real backend (real device flow, migrations, session cookies) — the server
takes its MySQL and Redis from `configs/config.yaml`, so point that at your own
instances:

```bash
go run ./cmd/server                              # real backend on :8443
cd e2e && E2E_SCRATCH_AUTOSTART=1 pnpm scratch
```

What that env var does is in
[`../e2e/README.md`](../e2e/README.md#needing-a-real-backend).

## Report rules

**Create `report.md` before the run and fill it in as you go.** A report reconstructed
afterwards from memory records what you believe happened, which is exactly the thing under
question. The template is
[references/verification-report-template.md](references/verification-report-template.md).

```
e2e/scratch/<task-name>/
├── report.md
├── screenshots/
├── videos/
└── resources/
```

**Evidence form follows what is being verified.** This is not "there must be pictures":

| Verifying | Evidence |
| --- | --- |
| UI behaviour or layout | Screenshot, one sentence on what it proves |
| A visual change | Two-column before/after table |
| A flow across steps | Recording, plus key still frames inline |
| An API or CLI result | The command in a code block, its exit code, the deciding output lines |
| A data effect | The query and its result — read the database directly, not through the UI |
| Logs / errors | The relevant lines, trimmed to what decides it |

A scenario with no UI holding only `report.md`, `logs/` and `resources/` is the right shape.
Screenshotting a terminal manufactures evidence instead of capturing it — paste the text.

**Evidence goes inline, not linked out.** One scroll should reach a verdict. Bare links are
for archives and binaries only.

**Query an independent oracle.** Asserting the UI says "approved" does not prove the row was
written. Check the database or the logs directly as well — a failed write behind a cheerful
UI is the exact failure this catches.

**Redact before pasting.** Tokens, secrets, real email addresses, session cookies.

## The honesty clause

**Never describe red as green.**

- If it failed, say so, and show the failure.
- If you could not verify part of it, say which part and why — an unverified claim presented
  as verified is worse than an admitted gap, because it stops anyone else from checking.
- When reproducing a bug, state which contract your scratch assertion encodes:
  **the expected behaviour** (so it stays red until the fix lands) or **the current buggy
  behaviour** (so it is green now and must be flipped when you fix it). An assertion whose
  polarity is undocumented becomes meaningless within a week.
- If you worked around something rather than fixing it, that goes in the report too.

## Why this track exists

A green `make test` does not mean the feature works. Unit tests check each piece in
isolation, so the failures they structurally cannot see are the ones where every piece is
correct and the *wiring* is not: a click handler that fires but updates nothing visible, a
write that returns success and lands in the wrong column, a redirect that resolves to the
wrong page. Those surface only when you drive the real thing end to end.

That is the question this track answers, and it is why "the tests pass" is not a
verification report.
