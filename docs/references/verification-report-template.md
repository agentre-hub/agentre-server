# Verification report template

Copy to `e2e/scratch/<task-name>/report.md` and fill in **as you go**, not afterwards.
Delete sections that do not apply — an empty heading is noise. The rules behind this
template are in [../verification.md](../verification.md).

---

# Verification: <what you built>

- **Date**: <YYYY-MM-DD>
- **Change**: <branch / commit / spec slug>
- **Verdict**: ✅ works / ⚠️ works with caveats / ❌ does not work

## What I claimed to have built

One or two sentences. The claim being tested — not a changelog.

## How I verified it

Environment (mocked / real PostgreSQL + Redis / against staging), and the commands run.

```bash
docker compose up -d pg redis
make dev
cd e2e && pnpm scratch
```

## Evidence

Inline, in whatever form fits what is being verified. One scroll to a verdict.

### <Scenario 1>

```bash
$ curl -s localhost:8443/v1/healthz
{"status":"ok","db_ping":true,"redis":true}
# exit 0
```

What this proves: <one sentence>.

### <Scenario 2 — a UI change>

| Before | After |
| --- | --- |
| `![before](screenshots/before.png)` | `![after](screenshots/after.png)` |

(Drop the backticks when you fill this in — they are here so the template itself
does not carry two permanently broken image links.)

What this proves: <one sentence>.

### Independent oracle

Do not take the UI's word for it — check the data or the logs directly.

```sql
SELECT id, status, approved_at FROM device_flow_codes WHERE user_code = 'A4F-7Q2';
-- 1 row, status=approved, approved_at set
```

## What I could NOT verify

Be specific about which part and why. "Everything checked out" with a gap left unstated is
the failure mode this section exists to prevent.

## Known issues found along the way

Anything you noticed but did not fix — with enough detail for someone to pick it up.
Per the workspace rules, unrelated problems get reported, not fixed on the side.

## If this reproduces a bug

State the polarity of the assertion explicitly:

- [ ] Asserts the **expected** behaviour → currently **red**, turns green when fixed
- [ ] Asserts the **current buggy** behaviour → currently **green**, must be flipped when fixed
