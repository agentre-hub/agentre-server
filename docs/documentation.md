# Maintaining these docs

## One fact, one owner

Every fact lives in exactly one document. Everything else links to it. Two copies drift,
and the reader hits the stale one without knowing it is stale.

| Fact | Owner |
| --- | --- |
| Project identity, non-negotiables, which doc to read when | [`../AGENTS.md`](../AGENTS.md) |
| Commands, exemption lists, migrations, commit flow | [develop.md](develop.md) |
| Layering, dependency direction, "how to add an X" | [architecture.md](architecture.md) |
| Test strategy per layer, build tags, guard tests | [testing.md](testing.md) |
| Verification workflow, report rules, honesty clause | [verification.md](verification.md) |
| e2e mechanics: configs, ports, hermetic guarantees | [`../e2e/README.md`](../e2e/README.md) |
| Tokens, theming, responsive, i18n | [design.md](design.md) |
| Logging, sensitive fields, metrics, traces | [observability.md](observability.md) |
| Release pipeline, Helm inputs, etcd seeding, k3s runtime shape | [deploy.md](deploy.md) |
| Quick start, Docker, GitHub OAuth setup | [`../README.md`](../README.md) |

`README.md` is for a **human setting the project up**. `AGENTS.md` and `docs/` are for
**someone changing the code**. When they overlap, README links to docs.

`CLAUDE.md` is a single `@AGENTS.md` line and holds nothing of its own. Do not add content
to it — anything written there is invisible to every other agent harness.

## Rules

**Every symbol, path and command must exist on this branch.** Verify with `git grep` and
`git ls-files`, not `rg` or `ls` — the latter match untracked files, so your uncommitted
experiment looks like the project's current state.

```bash
git grep -n "LoadServerConfig" -- '*.go'
git ls-files 'docs/*'
```

Beware `\b` in `git grep` patterns — it does not behave the way PCRE does here and will
silently match nothing, so a search for violations comes back clean when there are plenty.
Prefer explicit character classes, and sanity-check any pattern that reports zero by
re-running a simpler version of it first.

**Lift examples from real code.** Find an existing call that exercises the convention,
simplify what is irrelevant, and change **not one character** of the call shape. An invented
example in an authoritative voice is worse than none — later agents copy it.

**Write the project's wrapper, not the underlying library.** `logger.Ctx(ctx)` not `zap.L()`;
`cn()` not `clsx`. The wrapper's existence is itself the convention being documented.

**Do not leave TODO skeletons.** If a section cannot be filled in truthfully, delete the
section. A hollow document promises a standard and delivers nothing, and after that nobody
reads the docs at all.

## When you change code

| You changed | Update |
| --- | --- |
| A Makefile target | [develop.md](develop.md) commands table, and `.github/workflows/ci.yml` if CI calls it |
| A lint rule or exemption | [develop.md](develop.md) enforced-rules table + the rule's guard test |
| Layering or a new layer | [architecture.md](architecture.md) |
| Colour tokens or theming | [design.md](design.md) |
| A locale key | Both locale files — `locale-parity.test.ts` will fail otherwise |
| Log fields, metrics, spans | [observability.md](observability.md) |
| Anything in `e2e/` | [`../e2e/README.md`](../e2e/README.md), and [verification.md](verification.md) if the workflow changed |
| `deploy/helm/`, `.gitea/workflows/`, the `Dockerfile`, or a config key the server reads at boot | [deploy.md](deploy.md) — its secrets table and etcd seeding list |

## Fact-checking a document

Docs rot silently — nothing fails when a doc goes stale. Periodically, and whenever a
document feels off:

```bash
# Do the commands still exist?
grep -E '^\s*make [a-z-]+' -o docs/*.md | sort -u
grep -E '^[a-z][a-z0-9_-]*:' Makefile

# Do the referenced paths still exist?
git ls-files | grep -F "internal/guards"

# Do the relative links resolve?
grep -oE '\]\([^)h][^)]*\)' docs/*.md AGENTS.md
```

Broken links and vanished symbols are the two failure modes worth checking for, along with
a third the commands above will not catch: a convention the docs describe that has **zero
implementations in the code**. All three stay invisible until someone tries to follow them.
