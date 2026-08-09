# Gitea Actions 部署到 k3s

> Status: Draft
> Owner: agentre-server maintainers
> Last updated: 2026-08-07

**Objective:** 往 Gitea 推分支即可把 agentre-server 构建成镜像并用 Helm 发布到 k3s 集群，对外以 `app.agentrehub.com` 提供 SPA 与 `/v1` API。

**Hard invariant:** 现有的 `make lint` / `make test` 门禁、`.github/workflows/ci.yml`、`docker-compose.yml` 的行为都不变；仓库仍然零 build tag；凭据不进仓库。

## Problem

1. **当前镜像既构建不了也起不来。** 实现阶段的 RED 步骤实测出三个独立缺陷，此前从未被跑到过：

   1. **构建就失败。** 仓库没有 `.dockerignore`，构建上下文 236.93MB，宿主机的
      `frontend/node_modules` 被 `COPY frontend ./frontend` 带进镜像；`pnpm install` 随后要
      清掉这个已存在的 modules 目录，在无 TTY 的构建环境里直接中止：
      `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。
   2. **配置路径不对。** `Dockerfile:18` 的 `WORKDIR /` 加 `ENTRYPOINT ["/server"]`，而
      `cmd/server/main.go:36` 调用 `configs.NewConfig("agentre-server")` 不带 Option，cago 的默认
      配置路径是 `./configs/config.yaml`（`configs/config.go:38`），也就是容器里的
      `/configs/config.yaml`。`Dockerfile:17` 却把示例配置放到了
      `/etc/agentre-server/config.yaml`，没有任何地方读它。文件源 `os.ReadFile` 失败即返回错误
      （`configs/file/file.go:17-25`），main 里 `log.Fatalf("load config: %v", err)` 直接退出。
      实测：`load config: open ./configs/config.yaml: no such file or directory`，exit 1。
   3. **示例配置缺 `source` 键。** 修掉路径之后错误变成 permission denied。以 root 跑才看到真因：
      `file config key not found: source`——cago 的文件源读不到某个键时会把默认值**写回配置文件**
      （`configs/file/file.go:33-43`），而镜像里这份文件 root 拥有、容器以 nonroot 跑，写不了。
      佐证：仓库里 `configs/config.yaml` 末尾的 `source: ""` 就是 cago 自己写回去的。

   三者都必须修掉镜像才能启动，因此本轮的交付物包含 `.dockerignore` 与
   `configs/config.example.yaml` 两处改动。
2. **没有任何 k8s 部署资源。** 仓库里只有面向单机的 `docker-compose.yml`，没有 chart、没有 Gitea 工作流；`.github/workflows/ci.yml` 只做门禁不做发布。上线只能手工 `kubectl`。
3. **配置下发方式未定，镜像也无从得知自己是哪个版本。** `Makefile:12-14` 会把 `buildinfo.Version` / `Commit` 注入 `bin/server`，但 `Dockerfile` 的 `go build` 没有 `-ldflags`，所以线上 pod 的启动日志（`main.go:31`）永远打印 `dev (unknown)`，排障时无法把 pod 对上 commit。

## Actors and user stories

1. 作为维护者，我想把分支推到 Gitea 就自动发布到对应环境，这样上线不依赖我本地的 kubeconfig。
2. 作为维护者，我想在 test / pre 环境用独立域名和独立 release 验证，这样不会碰到生产。
3. 作为运维者，我想在不重新构建镜像的前提下改配置，这样调参数不需要走一次发布。
4. 作为排障者，我想从 pod 日志第一行就知道跑的是哪个 commit，这样能把线上现象对回代码。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 域名 `app.agentrehub.com`，非生产环境加前缀（`test.` / `pre.`） | 用户决定。Rejected: `server.agentre.dev`（`configs/config.example.yaml:47` 的旧值）——用户已改用新域名 |
| 2 | chart 只部署 server 自身，PostgreSQL / Redis 复用集群已有实例 | 用户决定。Rejected: 用 bitnami subchart 一起部署——`helm uninstall` 会连数据一起带走，生产库不该受应用 chart 的生命周期管辖 |
| 3 | 配置走 etcd 配置中心，ConfigMap 只放引导配置 | 用户决定，与 scriptlist 同源。Rejected: ConfigMap + Secret 全量下发——改配置要重新 `helm upgrade` |
| 4 | 不新增 Go 代码即可启用 etcd 配置源 | `pkg/component/core.go:8` 已经 blank-import 了 `configs/etcd`，而 `cmd/server/main.go` 导入了 `pkg/component`，`init()` 已把 `sources["etcd"]` 注册好。Rejected: 在 main.go 里再加一次 blank import——重复且无效果 |
| 5 | ConfigMap 必须同时含 `env`、`debug`、`source`、`etcd` 四个键 | 文件源在键缺失时会**回写配置文件**（`configs/file/file.go:33-43`），而 subPath 挂载的 ConfigMap 是只读的，缺一个键就 CrashLoop。这四个键正好是切换到 etcd 之前会被读到的全部键 |
| 6 | ConfigMap 里的 `env` 用小写（`prod` / `pre` / `test`） | etcd 前缀是 `path.Join(prefix, string(cfg.Env), appName)`（`configs/etcd/etcd.go:22`），且 `pkg/component/core.go:31` 用 `cfg.Env != configs.PROD` 决定是否暴露 `/swagger`——大写 `PROD` 会绕过这个判断把 swagger 暴露到线上。Rejected: 沿用 `configs/config.example.yaml:1` 的大写 `PROD`。补充：交付后经用户确认，该示例文件的 `env` 也一并改成小写，理由相同——否则本地开发时 `/swagger` 是暴露的 |
| 7 | Dockerfile 改 `WORKDIR /app`，配置读 `/app/configs/config.yaml` | 修 Problem 1，且与 chart 的 subPath 挂载点、scriptlist 的既有约定一致。Rejected: 给 `configs.NewConfig` 传 Option 改路径——那是改 Go 生产代码，而问题出在镜像布局 |
| 8 | 运行时镜像保持 distroless static + nonroot | 现状即如此，静态二进制不需要 debian；distroless static-debian12 自带 CA 证书（GitHub OAuth 需要）与 zoneinfo。Rejected: 换成 scriptlist 的 `debian:12-slim`——攻击面更大且无收益 |
| 9 | 日志只走 stdout，不落盘，chart 不带 PVC | nonroot 用户在只读根文件系统上写 `./runtime/logs/` 会失败；k8s 的惯例是 stdout 由采集侧接管。据此 etcd 里的 `logger.logFile.enable` 应为 `false`。Rejected: 照搬 scriptlist 的 `storage.yaml` PVC——本服务不写盘 |
| 10 | 镜像通过 `--build-arg` 拿到 `VERSION` / `COMMIT` 并注入 ldflags | 修 Problem 3，与 `Makefile:12-14` 已有的注入点同源 |
| 11 | Ingress 单条 `/` 规则 | 同一个二进制既发 SPA（`internal/web`）又发 `/v1`（`internal/api/router.go`），不像 scriptlist 那样前后端分离需要按前缀切分 |
| 12 | Gitea 侧只跑后端门禁（golangci-lint + `go test`），前端由镜像构建阶段的 `pnpm build` 兜底 | 用户决定。前端 `build` 脚本是 `tsc -b && vite build`（`frontend/package.json:9`），类型错误会直接断掉镜像构建，所以并非无人把关。且 runner 上不需要 node/pnpm/playwright——与 scriptlist 两个仓库的做法一致。Rejected: 在 `.gitea/workflows` 里复刻整条 ci.yml——门禁定义变成两处维护 |
| 13 | 镜像仓库地址、凭据、kubeconfig 全部来自 Gitea secrets | 用户决定，与 scriptlist 同源。Rejected: 把 registry 地址写死进仓库 |
| 14 | ingress class 用 `k3s-main-nginx`，etcd 用 `etcd-config.core.svc.cluster.local:2379`（prefix `/config`） | 用户决定：与 scriptlist 同一个 k3s 集群、同一个 etcd 实例，仅靠 `/config/<env>/agentre-server` 前缀隔离。Rejected: traefik / 独立 etcd 实例 |
| 15 | TLS 证书引用集群里已存在的 Secret（默认名 `agentrehub-com-tls`） | 用户决定，与 scriptlist 同源。Rejected: cert-manager 注解自动签发——集群是否装了 cert-manager 未经确认，且会把证书生命周期塞进应用 chart |
| 16 | 所有 `uses:` 改写成 `actions/*` 命名空间，上游名字以注释保留在上一行 | Gitea 的 `DEFAULT_ACTIONS_URL` 官方默认其实是 `github`，但 scriptlist 的两个仓库把 `docker/*`、`azure/*`、`golangci/*` 全部改写成了 `actions/*` 且能跑通，说明 gitea.icodef.com 这台配的是 `self`、动作镜像在本地 `actions` 组织下。这是实例配置而非 Gitea 通则，所以依据是同一台实例的既有证据。Rejected: 写 `uses: https://github.com/...` 绝对 URL——绕过内网镜像，在该网络下不可靠 |
| 17 | 工作流里展开写命令，不调 Makefile target | 用户决定：runner 镜像是否带 `make` 不确定。与 `docs/develop.md`「CI 只负责调用 Makefile」的规则有冲突，因此仅限 `.gitea/` 这一条工作流，`.github/workflows/ci.yml` 不动，规则在 GitHub 侧仍然成立。Rejected: 调 `make test-backend`——`make` 缺失会让首次发布直接失败 |
| 18 | `go test` / golangci-lint 之前必须先造出 `internal/web/dist/index.html` | `internal/web/embed.go` 用 `//go:embed` 嵌入 `dist`，而 `.gitignore:12` 忽略了该目录，干净 checkout 上不造占位文件会**编译期**失败。这正是 `Makefile:37-40` 的 `prepare-web-dist` 存在的原因；按决策 17 在工作流里展开成等价的 mkdir + printf。Rejected: 提交一个占位 dist 进仓库——污染构建产物目录 |
| 19 | 工作流不使用 `if:` 条件与 `concurrency:` | Gitea 的表达式实现只支持 `always()` 一个状态函数（官方 comparison 文档），`if: failure()`（`.github/workflows/ci.yml` e2e 那步在用）在 Gitea 上不成立；scriptlist 的两条工作流也确实一个 `if:` 都没有。`runs-on` 同理只写 `ubuntu-latest` 单值 |
| 20 | 三个基础镜像都改成可覆盖的 ARG，并把 `GOPROXY`、`NPM_REGISTRY` 作为 build-arg 传入 | 本仓库前端与后端**都在 Docker 内构建**（不像 scriptlist 在 runner 上 `go build` 完再塞进瘦镜像），所以内网镜像源必须穿透到构建阶段，否则在该网络下会卡死。`gcr.io/distroless/static-debian12` 与 `debian:12-slim` 不同源，没法共用一个 `BASEIMAGE` 前缀，因此三个基础镜像各自一个 ARG，默认值保持上游地址以便本地 `make docker` / `docker-compose` 照常可用 |

## Gitea Actions 与 GitHub Actions 的差异

**加入 `.gitea/workflows/` 会让 Gitea 完全停止读取 `.github/workflows/`。** Gitea 的 `listWorkflowsInDirs()` 按 `WorkflowDirs`（默认 `[".gitea/workflows", ".github/workflows"]`）逐个查找，**找到第一个存在的目录就 break，两者不合并**。因此本轮交付之后，Gitea 上跑的只有 `.gitea/workflows/deploy.yaml`；`.github/workflows/ci.yml` 仍然是 GitHub 侧的完整门禁，两边职责不同且不再互为兜底。这一点必须写进文档，否则后续有人以为改 `ci.yml` 就能同时影响两边。

工作流的写法受以下实测约束（见决策 16–20）：动作命名空间用 `actions/*`；不使用 `if:` 与 `concurrency:`；`runs-on` 只写单值；不依赖 runner 上的 `make`；Go 相关步骤之前先造 embed 占位文件。

## 触发与环境映射

推送到 `main` 发布 `prod`，推送到 `release/*` 发布 `pre`，推送到 `test/*` 发布 `test`；其它分支不触发发布。环境决定四件事，且只决定这四件事：Helm release 名（生产为仓库名本身，非生产为 `<仓库名>-<env>`）、对外域名（生产 `app.agentrehub.com`，非生产 `<env>.app.agentrehub.com`）、资源请求量（生产更高）、是否开启 HPA（仅生产）。镜像 tag 一律是 `<env>.<7 位短 commit>`，因此同一个 commit 在不同环境是不同的 tag，不会互相覆盖。

发布过程的失败必须让工作流失败：门禁不过、镜像构建失败、`helm upgrade` 返回非零，都不允许继续走到下一步或静默成功。

## 镜像

镜像自带构建好的前端与后端二进制：前端 `pnpm build` 的产物落到 `internal/web/dist`，由 `//go:embed` 进二进制，因此运行时不需要额外的静态文件卷。构建全过程在 Docker 内完成，runner 上除 Go 门禁外不需要任何工具链。

由此镜像必须能在受限网络下构建：三个基础镜像（前端 node、构建期 golang、运行期 distroless）各自是一个可覆盖的 ARG，Go 模块代理与 npm registry 也各是一个 ARG。全部 ARG 的默认值保持上游地址，因此本地 `make docker` 与 `docker-compose build` 不传任何参数也照常工作；发布工作流按需从 secrets 覆盖它们。任一 ARG 被覆盖成不可达地址时，构建必须失败退出而不是回退到上游默认值——静默回退会在网络受限时表现为长时间挂起。

容器以非 root 运行，工作目录 `/app`，监听 8443（来自配置中的 `http.address`）。镜像内置一份配置文件占位，实际运行时由 chart 用 ConfigMap 覆盖同一路径。容器启动时打印的版本与 commit 必须等于构建这次镜像的 commit，而不是 `dev (unknown)`。

## 配置下发

Pod 里 `/app/configs/config.yaml` 由 ConfigMap 提供，内容只有引导所需的四个键：`env`、`debug`、`source: etcd`、`etcd`（endpoints 与用户名密码）。etcd 是集群里已有的 `etcd-config.core.svc.cluster.local:2379`，与 scriptlist 共用，靠前缀隔离。业务配置——`http`、`db`、`redis`、`logger`、`trace`、`server`——全部存放在 etcd 的 `/config/<env>/agentre-server/<key>` 下，由运维在首次发布前写入。

etcd 凭据由 `helm upgrade` 时传入，不写进仓库。敏感字段（GitHub OAuth client secret、session secret、JWT 私钥）存在 etcd 的 `server` 键内；`internal/bootstrap/cago.go:80-86` 已有的 `AGENTRE_SERVER_*` 环境变量覆盖通道保持可用但本次不启用，因为 etcd 已经承担了这个职责。

**首次发布前 etcd 必须已被写入。** cago 在 etcd 里读不到某个键时，会把零值写回该键并返回错误（`configs/etcd/etcd.go:57-72`），组件启动随即失败——表现为 pod 反复 CrashLoop，且每重启一次多播种一个零值键。这不是可以靠重启自愈的状态，文档必须写清楚需要先播种，并给出这一份键的清单与示例内容。

## 集群内的形态

Service 以 80 端口对内暴露，转发到容器的 8443。Ingress 用 `k3s-main-nginx` 这个 class，把域名下的 `/` 全部指到该 Service，TLS 证书取自集群里已存在的 Secret（默认 `agentrehub-com-tls`，可由 values 覆盖）；chart 不负责签发证书，Secret 不存在时 ingress 只是不提供 TLS，不影响 chart 安装成功。

存活与就绪探针都打 `GET /v1/healthz`。需要明确知道其语义：该端点在 DB / Redis 不通时仍返回 200，只是把 `db_ping` / `redis` 置为 false（`internal/controller/healthz_ctr/healthz.go`），所以就绪探针不会因为下游抖动把 pod 摘掉——本次沿用这个行为，不改控制器。

生产开启 HPA 按 CPU 扩缩，非生产固定单副本。

## Out of scope

- 让 `/v1/healthz` 在 DB/Redis 不通时返回非 200：那是改 controller 的可观测行为，需要单独的 spec 与回归测试。
- 部署 PostgreSQL / Redis / etcd 本身（决策 2、3）。
- 证书签发（cert-manager 等）：chart 只引用已存在的 TLS Secret。
- 改动 `.github/workflows/ci.yml` 与任何 Go 生产代码。GitHub 侧的门禁保持原样，本轮不因为 Gitea 的存在去动它。
  （交付后经用户要求追加：`Dockerfile` 与 `docker-compose.yml` 移入 `deploy/`，`docs/deploy.md` 改写为面向人的
  `deploy/README.md`。compose 一并修好——它原先传的 `AGENTRE_SERVER_DB_DSN` / `_REDIS_ADDR` 根本没有代码读，
  服务会去连镜像内置配置里的 127.0.0.1，即单机部署此前也是跑不起来的。）
- 在 Gitea 侧复刻前端 eslint / vitest / playwright（决策 12），以及为非发布分支单独加一条 test 工作流。
- 前端构建产物 CDN 化、灰度/金丝雀（scriptlist 的 istio gateway chart 不搬）。

## Testing decisions

本仓库没有可用于 Helm/CI YAML 的自动化测试框架，且 chart 与工作流不进 `go test` 的可达范围。据此本轮的验证以可复现的命令为准，全部在报告中附上真实输出：

| Seam | What it verifies | Prior art |
|---|---|---|
| `helm lint deploy/helm` | chart 语法与 values 结构可用 | none |
| `helm template` 分别渲染 prod / test 两组 `--set` | 环境映射（release 名、域名、资源、HPA 开关、镜像 tag）确实按上面写的分叉 | none |
| `docker build` + `docker run` | Problem 1 的修复：容器能读到 `/app/configs/config.yaml` 并越过 `load config` 这一步；启动日志打印真实 commit 而非 `dev (unknown)` | none |
| `make lint` / `make test` | 本轮没有碰坏任何既有门禁 | `.github/workflows/ci.yml` |
| `.gitea/workflows/deploy.yaml` 的 YAML 解析 | 工作流文件本身语法可用，且不含决策 19 禁止的 `if:` / `concurrency:` / 多值 `runs-on` | none |
| 干净 checkout 上先删掉 `internal/web/dist` 再跑工作流里那段 Go 门禁命令 | 决策 18：不造 embed 占位文件时确实编译失败，造了之后通过 | `Makefile:37-40` |

无法在本地自动化的部分，报告里必须逐条标注为未实跑：`helm upgrade` 真正打到 k3s；该 Gitea 实例上 `actions/*` 命名空间下这几个动作是否都已镜像；GHA 缓存后端（`cache-from: type=gha`）在该实例是否可用；etcd 播种后的首次成功启动。前两项只能由首次推送覆盖，本轮的依据是 scriptlist 在同一台实例上用同一组动作跑通的既有事实。

`docker run` 一步先在修复前跑一次以复现 Problem 1（预期 `load config` 失败），再在修复后跑一次。
