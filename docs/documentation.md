# Maintaining these docs

## One fact, one owner

Every fact has one owner; other documents link to it.

| Fact | Owner |
| --- | --- |
| Project identity, non-negotiables, which doc to read when | [`../AGENTS.md`](../AGENTS.md) |
| Commands, exemption lists, migrations, commit flow | [develop.md](develop.md) |
| Layering, dependency direction, "how to add an X" | [architecture.md](architecture.md) |
| Test strategy per layer, build tags, guard tests | [testing.md](testing.md) |
| Verification workflow, report rules, honesty clause | [verification.md](verification.md) |
| e2e mechanics: configs, ports, hermetic guarantees | [`../e2e/README.md`](../e2e/README.md) |
| Tokens and the canvas↔code name mapping, type/spacing/radius scales, the auth shell and page skeleton, theming, responsive, i18n, async-state rendering, accessibility | [design.md](design.md) |
| Logging, metrics, traces | [observability.md](observability.md) |
| Deployment: Docker, Kubernetes, chart values, etcd seeding, release pipeline | [`../deploy/README.md`](../deploy/README.md) |
| Quick start, Docker, GitHub OAuth setup | [`../README.md`](../README.md) |

`README.md` serves setup; `AGENTS.md` and `docs/` serve code changes. README links to docs
instead of duplicating them.

Keep `CLAUDE.md` as its single `@AGENTS.md` line.

## Rules

**Every symbol, path and command must exist on this branch.** Verify tracked content with
`git grep` and `git ls-files`; `rg` and `ls` also include untracked experiments.

```bash
git grep -n "LoadServerConfig" -- '*.go'
git ls-files 'docs/*'
```

Avoid `\b` in `git grep` patterns; use explicit character classes. Sanity-check a zero-result
pattern with a simpler search.

**Lift examples from real code.** Remove irrelevant context without changing the call shape.

**Write the project's wrapper, not the underlying library.** `logger.Ctx(ctx)` not `zap.L()`;
`cn()` not `clsx`. The wrapper's existence is itself the convention being documented.

**Do not leave TODO skeletons.** Delete sections that cannot be filled truthfully.

## When you change code

| You changed | Update |
| --- | --- |
| A Makefile target | [develop.md](develop.md) commands table, and `.github/workflows/ci.yml` if CI calls it |
| A lint rule or exemption | [develop.md](develop.md) enforced-rules table |
| Layering or a new layer | [architecture.md](architecture.md) |
| Colour tokens, theming, a scale step, or the shared shell (`AuthLayout`) | [design.md](design.md) |
| A locale key | The corresponding en and zh-CN module files; wire a new module into both bundles |
| Log fields, metrics, spans | [observability.md](observability.md) |
| Anything in `e2e/` | [`../e2e/README.md`](../e2e/README.md), and [verification.md](verification.md) if the workflow changed |
| Anything in `deploy/`, `.gitea/workflows/`, or a config key the server reads at boot | [`../deploy/README.md`](../deploy/README.md) — its secrets table and etcd seeding list |

## Fact-checking a document

Periodically, and whenever a document feels stale:

```bash
# Do the commands still exist?
git grep -h -E '^\s*make [a-z-]+' -- 'docs/*.md' | sort -u
git grep -n -E '^[a-z][a-z0-9_-]*:' -- Makefile

# Do the relative links resolve?
git grep -n -E '\]\([^)h][^)]*\)' -- 'docs/*.md' AGENTS.md
```

Also check that documented conventions still have implementations; the commands above do not
detect that failure.
