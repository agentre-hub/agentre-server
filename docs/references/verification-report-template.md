<!-- Copy into e2e/scratch/<scenario>/ as report.md before running, and fill it in as you go. Headings stay English; write the record in the user's language. Delete unused sections and this comment. The rules behind this template are in ../verification.md. -->

# Verification: <scenario>

## Mode

`verifying a change` | `reproducing a bug`

## Goal / problem

<The claim being tested — not a changelog. Or, for a bug, Expected/Actual.>

## Environment

<!-- What the run drove, so a reader can tell a mocked run from a real-backend one. -->

- Form and entry point: `<make e2e / curl with explicit config / pnpm serve + pnpm drive / pnpm scratch>`
- Backend and data: `<formal server plus real MySQL/Redis from the explicit E2E config, or an authorized substitute>`
- Build under test: `<branch, commit or spec slug>`
- Form factors driven: `<desktop-chromium / mobile-chromium / both — UI rows only>`

## Verdict

<!-- Fill last. Keep verdicts only here. One row per claim — split a compound claim rather than averaging it. Where `not observed` came from unconfigured environment, "How observed" names the service and the absent config keys, never values. -->

| # | Requirement / bug claim | Verdict | Real / substituted | How observed | Check it yourself |
|---|---|---|---|---|---|
| V1 | `<one behaviour or bug claim, stated so it can only be true or false>` | holds / does not hold / not observed | real, or `substituted: <what stood in> — <what it does not cover>` | `<the runtime observation that decides it>` | `<command, or launch command plus steps>` |

Summary: <what holds, the deciding observation, every not-observed/failed item and shipping implication>.

| Label | Use it when | Requires |
|---|---|---|
| `holds` | you observed the behaviour at runtime | the deciding observation, and how a reader reaches it |
| `does not hold` | you observed it failing, or the bug reproducing | the failing output, assertion diff or error screenshot |
| `not observed` | you never reached the check | what stopped it |

An unreached check is never `holds`; a run that verified two of three claims is reported as two of three.

## Authorization

<!-- Keep only when a real dependency was substituted or an external effect was authorized. The current E2E fixture has no API route mocks; any substitute must be explicit and authorized. -->

| # | Substitute or effect | The user's authorization, verbatim |
|---|---|---|
| V1 | `<what stood in for what, or the effect and what it touches>` | `<sentence>` |

## Reproduction steps

<!-- Keep for bug reproduction; state the polarity explicitly. -->

1. `<clean-checkout-to-observation steps>`

- [ ] Asserts the **expected** behaviour → currently **red**, turns green when fixed
- [ ] Asserts the **current buggy** behaviour → currently **green**, must be flipped when fixed

## Acceptance evidence

<!-- One `###` per verdict row, holding everything that decides it in the order observed. No verdict labels here. A row with no section is `not observed`. -->

### V1 · `<the claim, restated>`

```console
$ curl -s localhost:8443/v1/healthz
{"status":"ok","db_ping":true,"redis":true}
$ echo $?
0
```

<What this proves>.

**Independent oracle.** Do not take the UI's word for it — read the data or the logs directly:

```sql
SELECT id, status, approved_at FROM device_flow_codes WHERE user_code = '<code>';
-- 1 row, status=approved, approved_at set
```

<!-- UI only; pair before/after or light/dark in one table so the comparison is one glance. Drop the backticks when filling this in — they keep the template itself from carrying broken image links. -->

| Before | After |
|---|---|
| `![before](screenshots/v1-before.png)` | `![after](screenshots/v1-after.png)` |

## Evidence index

- Commands/logs: `<inline deciding output plus optional full-file links>`
- Resources/data snapshots: `<paths and what each proves>`
- Screenshots/video: `<UI only; a recording carries a verdict only alongside its decisive stills>`

A scenario with no `screenshots/` is the right shape for an API, migration or daemon run.

## Persistent data changes

<!-- Keep only when the run wrote data that outlives it — a real database, a migration against real rows. -->

| Change | Forward | Backward/backup | Before/after query |
|---|---|---|---|
| `<scope/blast radius>` | `<command/exit>` | `<command/exit or irreversible plan>` | `<evidence>` |

Dataset: `<source, size and representative edge values>`. **Green on an empty database is not evidence.**

## Execution record

| Step | Status | Evidence/blocker |
|---|---|---|
| `<step>` | pending / passed / failed / blocked | `<path or observation>` |

## Known issues found along the way

<!-- Anything noticed but not fixed, with enough detail for someone to pick it up. Unrelated problems get reported, not fixed on the side. -->

## Integrity and cleanup

- Initial/final HEAD: `<sha>` / `<sha>`
- Final `git status --porcelain=v1`: `<output>`
- Created artifacts, processes and external data, and how each was cleaned up: `<inventory; a server you started is one>`
- Redaction performed: `<what was removed>`

## Evidence rules

- Every `holds` names how the target was driven — command, or launch command plus steps — and the deciding observation.
- Where a claim changes state beyond the driven surface, that observation is an independent read with its own command: the database or the logs, not the UI.
- Embed decisive text and images inline; one scroll should reach a verdict. Bare links are for archives and binaries only, each with a note on what it holds.
- Paste terminal output as text. Screenshotting a terminal manufactures evidence instead of capturing it.
- Keep failed and unchecked steps visible. Redact tokens, secrets, real email addresses and session cookies before saving, and again before embedding.
- Keep every path relative to this file; the scenario directory, not `report.md` alone, is what you hand to a reviewer.
