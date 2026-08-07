# docs

Start at [`../AGENTS.md`](../AGENTS.md) — it holds the project facts, the
non-negotiables, and the routing table that says which of these to open when.

| Document | What it owns |
| --- | --- |
| [develop.md](develop.md) | Commands, repo layout, enforced rules + exemptions, migrations, commit flow |
| [architecture.md](architecture.md) | Layering, dependency direction, "how to add an X" |
| [testing.md](testing.md) | What to test per layer, sqlmock vs mockgen, build tags, guard tests |
| [verification.md](verification.md) | Twin e2e tracks, scratch workflow, report rules |
| [design.md](design.md) | Colour tokens, dark/light, responsive, i18n, new-page recipe |
| [observability.md](observability.md) | Logging, sensitive fields, metrics, traces |
| [deploy.md](deploy.md) | Gitea release pipeline, Helm chart inputs, etcd seeding, k3s shape |
| [documentation.md](documentation.md) | Who owns which fact, how docs stay true |

`references/` holds detail too long for a main document:

- [references/verification-report-template.md](references/verification-report-template.md)

**Each fact lives in exactly one document.** If you need to state something a
second time, link to the owner instead — two copies drift, and the agent reads
the stale one.
