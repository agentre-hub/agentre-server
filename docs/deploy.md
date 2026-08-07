# Deploying to k3s

Pushing a branch to Gitea builds an image and releases it with Helm.
This document owns the release pipeline, the Helm chart's inputs, and the etcd
seeding that has to happen **before** the first release.

Local commands live in [develop.md](develop.md); this is only about shipping.

## Gitea is not GitHub here

`.gitea/workflows/` exists in this repo, and that switches off `.github/workflows/`
**on Gitea only**. Gitea's `listWorkflowsInDirs()` walks `WorkflowDirs`
(default `[".gitea/workflows", ".github/workflows"]`), stops at the first directory
that exists, and never merges the two.

So the two CI surfaces are disjoint, and neither backs the other up:

| Surface | Runs | Covers |
| --- | --- | --- |
| GitHub — `.github/workflows/ci.yml` | push to `main`, every PR | golangci-lint, `make test`, e2e, embed build |
| Gitea — `.gitea/workflows/deploy.yaml` | push to `main`, `release/*`, `test/*` | golangci-lint, `go test ./...`, image build, `helm upgrade` |

The Gitea side deliberately skips the frontend's eslint/vitest/playwright. The
frontend still cannot break silently: the image build runs `pnpm build`, which is
`tsc -b && vite build`, so a type error fails the release.

Three more Gitea constraints the workflow is written around — breaking any of them
fails at parse time or, worse, silently:

- **Actions resolve on this Gitea instance**, whose `DEFAULT_ACTIONS_URL` is `self`.
  Every `uses:` is rewritten into the `actions/*` namespace with the upstream name in a
  comment above it: `docker/build-push-action@v6` becomes `actions/build-push-action@v6`.
- **Only `always()` exists** among status functions. No `if: failure()`, no `if: success()`.
  The workflow uses no `if:` at all, and no `concurrency:`.
- **`runs-on` takes a single value**, not a matrix expression.

## Trigger and environment mapping

| Branch | Env | Release | Host |
| --- | --- | --- | --- |
| `main` | `prod` | `agentre-server` | `app.agentrehub.com` |
| `release/*` | `pre` | `agentre-server-pre` | `pre.app.agentrehub.com` |
| `test/*` | `test` | `agentre-server-test` | `test.app.agentrehub.com` |

The environment decides four things and nothing else: release name, host, CPU/memory
requests (`500m`/`512Mi` in prod, `100m`/`128Mi` elsewhere), and whether the HPA is on
(prod only, min 2 replicas). Image tags are always `<env>.<short-sha>`, so the same
commit produces a distinct tag per environment and they never overwrite each other.

## Gitea secrets

| Secret | Required | Falls back to |
| --- | --- | --- |
| `DOCKER_USERNAME`, `DOCKER_TOKEN` | yes | — |
| `KUBE_CONFIG` | yes | — |
| `ETCD_CONFIG_PASSWORD` | yes | — |
| `DOCKER_REGISTRY` | no | `docker.io` |
| `GOPROXY` | no | `https://goproxy.cn,direct` |
| `NPM_REGISTRY` | no | `https://registry.npmmirror.com` |
| `NODE_IMAGE` | no | `node:22-alpine` |
| `GO_IMAGE` | no | `golang:1.26-alpine` |
| `RUNTIME_IMAGE` | no | `gcr.io/distroless/static-debian12` |
| `TLS_SECRET_NAME` | no | `agentrehub-com-tls` |

The three image secrets are full image references, not a shared registry prefix —
`gcr.io/distroless/...` and `docker.io/library/node` do not share one.

Both the frontend and the Go binary are built **inside** the image, so `GOPROXY` and
`NPM_REGISTRY` are passed in as build args. Corepack fetches pnpm itself from a
different variable than pnpm uses for packages, so the Dockerfile sets both
`COREPACK_NPM_REGISTRY` and `npm_config_registry`.

`TLS_SECRET_NAME` names a TLS Secret that must already exist in the namespace; the chart
never issues certificates. A certificate for `app.agentrehub.com` does not cover
`test.app.agentrehub.com`, so either point non-prod at a Secret whose certificate covers
it, or set the secret to an empty value to serve those environments over plain HTTP.

## Seed etcd before the first release

Only four keys reach the pod from Kubernetes — `env`, `debug`, `source`, `etcd`, rendered
into a ConfigMap and mounted at `/app/configs/config.yaml`. Everything else is read from
etcd at `/config/<env>/agentre-server/<key>`.

**A missing key does not fall back to a default, and the pod does not recover on its own.**
When cago cannot find a key in etcd it writes the zero value back to that key and returns
an error, so the component fails to start. The pod crashloops, and every restart seeds one
more empty key. Seed etcd first.

These keys are mandatory, in the order the server hits them:

| Key | Read by |
| --- | --- |
| `logger` | `component.Core()` — the first thing to fail if etcd is empty |
| `db` | `component.Database()` |
| `redis` | `component.Redis()` |
| `http` | `mux.HTTP` — `address` must match the chart's `containerPort` (8443) |
| `server` | `bootstrap.LoadServerConfig` |

`trace` is optional: `cmd/server/main.go` logs `tracing disabled` and continues when it is
absent. Seed it if you want tracing. `metric` and `cron` read no configuration.

Take the shape of each value from [`../configs/config.example.yaml`](../configs/config.example.yaml),
with three changes for the cluster:

- `logger.logFile.enable` must be `false`. The container runs as `nonroot` on a read-only
  root filesystem and cannot create `./runtime/logs/`; Kubernetes collects stdout anyway.
- `db.dsn` and `redis.addr` point at the in-cluster PostgreSQL and Redis.
- `server.public_url` is the environment's own host, e.g. `https://app.agentrehub.com`.

Secrets — the GitHub OAuth client secret, the session secret, the JWT private key — live
inside the `server` key. `internal/bootstrap/cago.go` also accepts `AGENTRE_SERVER_*`
environment overrides, but this deployment does not use them; etcd owns those values.

Seed one key like this, repeating per environment:

```bash
etcdctl --endpoints=etcd-config.core.svc.cluster.local:2379 \
  --user root:"$ETCD_PASSWORD" \
  put /config/prod/agentre-server/logger 'level: info
disableConsole: false
logFile:
  enable: false'
```

Check what is already there before releasing:

```bash
etcdctl --endpoints=... --user root:"$ETCD_PASSWORD" \
  get --prefix --keys-only /config/prod/agentre-server/
```

### The etcd key's YAML shape is version-sensitive

The ConfigMap writes the etcd connection twice — once flattened, once nested under
`config:`. Both carry identical values, and **neither copy is redundant**.

`configs/etcd.Config` in cago embeds `dbetcd.Config`. The pinned version tags that
embedded field with `mapstructure:",squash"` only, but this section is decoded by the file
source using `gopkg.in/yaml.v3`, which ignores mapstructure tags and does not flatten
anonymous fields unless they carry `yaml:",inline"`. It therefore looks for a `config:`
key. Writing only the flattened form parses to `endpoints: []` with no error, and the
client then has nothing to dial. A later cago adds `yaml:",inline"` and reads the
flattened form instead, ignoring the extra `config:`. Writing both survives that upgrade;
drop the nested copy once cago is bumped past that change.

## Shape in the cluster

One binary serves both the SPA and `/v1`, so the Ingress is a single `/` rule — there is
nothing to split by prefix. The Service exposes port 80 and forwards to the container's
8443. No PersistentVolumeClaim exists: the service writes nothing to disk.

Both probes hit `GET /v1/healthz`. Note what that endpoint does **not** do: it returns 200
even when PostgreSQL or Redis is unreachable, reporting `db_ping: false` / `redis: false`
in the body. Readiness therefore does not remove a pod when a dependency wobbles. That is
the existing behaviour and this deployment keeps it; changing it means changing
`internal/controller/healthz_ctr/healthz.go`.

`appConfig.env` is lowercase on purpose. cago's `pkg/component/core.go` compares it against
`configs.PROD` (`"prod"`) to decide whether to expose `/swagger`, so an uppercase `PROD`
would publish the Swagger UI in production. Note that
[`../configs/config.example.yaml`](../configs/config.example.yaml) still says `PROD`, which
is fine for local development and deliberately left alone — the cluster value comes from
the chart, not from that file.

The Deployment carries a `checksum/config` annotation over the rendered ConfigMap, so
changing the etcd address or credentials rolls the pods instead of waiting for the next
release.

## Building the image by hand

```bash
make docker    # tags agentre/server:0.1, stamps VERSION/COMMIT from git
```

Every base image and registry is an overridable build arg, defaulting upstream, so this
works with no arguments:

```bash
docker build -t agentre-server:local \
  --build-arg GO_IMAGE=my-mirror/golang:1.26-alpine \
  --build-arg GOPROXY=https://goproxy.cn,direct \
  --build-arg VERSION=1.2.3 --build-arg COMMIT=abc1234 .
```

The container reads `./configs/config.yaml` relative to its `/app` working directory. To
run it against a config of your own, mount over that path:

```bash
docker run --rm -p 8443:8443 \
  -v "$PWD/configs/config.yaml:/app/configs/config.yaml:ro" agentre-server:local
```

A config file mounted this way must be readable **and** contain every key the server
looks up before it reaches its configured source, because cago rewrites the file when a
key is missing and the mount is read-only. That is `env`, `debug` and `source` at minimum;
`source: etcd` adds `etcd`.

## When a pod will not start

```bash
kubectl -n app logs -l app.kubernetes.io/instance=agentre-server --tail=50
kubectl -n app get pods -l app.kubernetes.io/instance=agentre-server
```

| Log line | Cause |
| --- | --- |
| `load config: open ./configs/config.yaml: no such file or directory` | ConfigMap not mounted, or mounted somewhere other than `/app/configs/config.yaml` |
| `load config: ... permission denied` | A bootstrap key is missing, so cago tried to rewrite the read-only mount. Check all four are present |
| `load config: context deadline exceeded` | etcd unreachable, or `endpoints` parsed empty — see the YAML shape note above |
| `file config key not found: <key>` | That key is missing from the ConfigMap |
| `etcd ... not found: <key>, initialized with default value` | That key is not seeded in etcd yet |

The first log line always names the running build, e.g.
`agentre-server prod.abc1234 (abc1234) starting`. If it says `dev (unknown)`, the image
was built without `VERSION`/`COMMIT` build args and cannot be traced back to a commit.

## Working in a git worktree

This repo sits in the `/Users/codfrm/Code/agentre` Go workspace, and `go.work` lists the
main checkout, not your worktree. Inside a worktree, `agentre-server/...` imports resolve
to the **main checkout**, so a build or test there silently exercises the wrong tree:

```bash
go list -f '{{.Dir}}' agentre-server/internal/web             # -> main checkout
GOWORK=off go list -f '{{.Dir}}' agentre-server/internal/web  # -> this worktree
```

Prefix every Go command in a worktree with `GOWORK=off`. Docker builds and CI are already
unaffected, because neither has a `go.work`.
