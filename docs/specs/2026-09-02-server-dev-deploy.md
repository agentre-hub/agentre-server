# agentre-server dev 环境自动部署

> Status: Approved
> Owner: agentre maintainers
> Last updated: 2026-09-02

**Objective:** 向 Gitea 推送 `dev` 分支后，`coding.local` 上的 dev server 在无人介入的情况下被替换为该 commit 构建出的容器，并以健康检查通过作为部署成功的判据。

**Hard invariant:** `main` / `release/*` / `test/*` 的现有 k8s 发布链路行为不变；dev 环境沿用现有的外部 etcd / MySQL / Redis，既有 `agentre_server_dev` 数据不迁移、不重建。

## Problem

1. **dev 环境没有部署链路，且当前是停的。**（已核实）目标机 `coding.local`（192.168.8.188）上 server 以裸二进制 `./bin/server` 的形式从 tmux 窗口启动，源码目录 `/root/code/agentre/agentre-server`。`ss -ltnp` 显示 8443 无监听，tmux 只剩一个 `zsh` 窗口——进程已经不在了。每次更新都要人工上机 pull、构建、重开 tmux 窗口。
2. **目标机没有 Go 工具链，构建无法在机器上原地完成。**（已核实）机器上 `go` 不在 PATH，`/usr/local/go` 不存在；只有 Node 24（nvm）、Docker 29.2.1、Compose v5.1.0。因此产物必须在别处构建后送达。
3. **现成的 `deploy/docker-compose.yml` 不适用于 dev。**（已核实）它会额外拉起 MySQL 9.7.2 与 Redis 7 并把数据落在仓库内的 `data/`，而 dev 的库是外部的 `192.168.8.141:3306/agentre_server_dev` 与 `192.168.8.141:6379`，直接套用等于把现有 dev 数据旁路掉。
4. **etcd 里的 dev 配置写着宿主绝对路径的 JWT 私钥。**（已核实）`/config/dev/agentre-server/server` 的 `jwt.keys[0].private_key_pem_path` 是 `/root/code/agentre/agentre-server/runtime/keys/jwt.key`。容器内不存在该路径，不处理会在启动时以 `read pem ...: no such file or directory` 失败。
5. **Gitea 上没有 `dev` 分支。**（已核实）`git ls-remote --heads gitea` 只有 `main` 与 `chore/frontend-deps-for-shared-ui`。

## Actors and user stories

1. 作为在本机开发的维护者，我希望 `git push gitea dev` 之后 dev 环境自动变成这个 commit，这样我不必再上机手工构建和重启。
2. 作为维护者，我希望 dev 与 `main` 走同一套门禁，这样 dev 环境里出现的问题不会是本可以被 lint / test 拦住的问题。
3. 作为维护者，我希望部署失败时流水线是红的且 dev 环境保持在旧版本，这样我不会以为部署成功了却在对着一个起不来的服务排查。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 新建 `.gitea/workflows/dev.yaml`，不改动 `deploy.yaml` | dev 与 k8s 链路的差异面很大（不需要 QEMU / 多架构、不需要 kubeconfig / helm / TLS secret），且现有 `deploy.yaml` 是正在服务 prod 的链路。隔离成独立文件后，dev 的任何改动都不可能影响 prod 发布。Rejected: 在 `deploy.yaml` 里加分支条件与两个 conditional deploy job——省掉约 40 行重复，但把 prod 发布置于 dev 迭代的风险之下 |
| 2 | 复用 `deploy/Dockerfile`，dev 镜像 tag 为 `dev.<short-sha>` | 与 `deploy.yaml` 的 `<env>.<short-sha>` 命名一致，dev 与 prod 用同一份构建定义，不会出现「dev 能起 prod 起不来」的镜像差异。Rejected: dev 专用 Dockerfile——引入第二份构建定义与随之而来的漂移 |
| 3 | dev compose 只声明 server 一个服务，配置仍 `source: etcd` | 用户决定。既有 dev 数据在 141 那台机上且已持久化，配置改动不需要发版，与 k8s 链路的配置读取方式保持同构。Rejected: compose 自带 MySQL + Redis——dev 环境自包含，但要先迁移 `agentre_server_dev` 的既有数据，且 dev 与 prod 的配置来源分叉 |
| 4 | 引导配置、JWT 密钥、compose 的 `.env` 都是机器本地文件，不进仓库 | 仓库已经把 `configs/config.yaml` 列入 `.gitignore`（第 21 行），即「引导配置属于机器不属于代码」是既定约定；且引导配置含内网 etcd 端点。Rejected: 提交 `deploy/config.dev.yaml`——违反既有约定并把内网拓扑写进公开仓库 |
| 5 | 把 etcd 里 dev 的 JWT 路径改成容器路径 `/keys/jwt.key`，由 compose 只读挂载 | 与 `deploy/README.md` 描述的 k8s 约定（`/keys/<kid>.key`）一致。Rejected: 按宿主原路径 `/root/code/agentre/agentre-server/runtime/keys` 挂进容器——能跑，但把容器绑死在机器上那份 git checkout 的存在性上 |
| 6 | 部署走 SSH：runner 构建并推 registry，再 SSH 到目标机 pull + compose up | 用户决定，且用户确认现有 runner 能路由到 192.168.8.188。Rejected: 在 `coding.local` 上装 act_runner——免 SSH 密钥与 registry 往返，但要在目标机常驻一个构建服务并占用其 CPU / 磁盘 |
| 7 | 首次切换（停 tmux 裸进程、建目录、改 etcd、配 SSH 密钥）由人工执行一次，不进流水线 | 用户决定。这些是一次性且不可逆的动作，放进流水线只有第一次有意义，之后永远是死代码。Rejected: 部署脚本里带接管逻辑 |

## 触发与门禁

推送到 Gitea 的 `dev` 分支触发 dev 流水线。除此之外没有别的触发源：`main` / `release/*` / `test/*` 仍然只被 `deploy.yaml` 接管，两个 workflow 的分支集合不相交，同一次推送不会同时跑两条链路。

门禁与 `main` 一致，且必须全部通过才进入构建：先造出 `internal/web/dist/index.html` 占位文件（缺了它 `//go:embed` 会在编译期失败），随后跑 golangci-lint v2.12.2 与 `go test -race ./...`。任何一步失败则流水线中止，不构建镜像、不触碰 dev 环境——dev 环境停留在上一个成功版本。

前端门禁不在这条链路上，仍由 GitHub 侧的 `ci.yml` 负责，与 `deploy.yaml` 的现状一致。

## 构建与镜像

门禁通过后用 `deploy/Dockerfile` 构建镜像并推送到与 prod 相同的 registry，tag 为 `dev.<short-sha>`。构建参数沿用 `deploy.yaml` 已有的那组（`NODE_IMAGE` / `GO_IMAGE` / `RUNTIME_IMAGE` / `GOPROXY` / `NPM_REGISTRY`），并把 `VERSION` 设为 `dev.<short-sha>`、`COMMIT` 设为 short sha，使服务启动首行日志能对回具体 commit。

只构建目标机所需的单一架构（linux/amd64，目标机已核实为 x86_64），不做多架构构建。

## 部署

部署以 SSH 方式对 `coding.local` 执行，凭据来自 Gitea secret，流水线不在日志中回显私钥或 registry 令牌。

目标机上存在一个部署目录，其中 compose 文件由流水线从仓库同步覆盖，其余文件是机器本地资产、流水线只读不写：

- **compose 文件** —— 每次部署由流水线覆盖，保证机器上跑的就是这个 commit 声明的编排。
- **`.env`** —— 由流水线改写其中的镜像 tag 一项；其余项（registry 地址等）是机器本地的。
- **引导配置** —— `env: dev`、`source: etcd`、指向 `192.168.8.141:2379`，只读挂载到容器的配置路径。
- **JWT 密钥对** —— 只读挂载到容器的 `/keys`。

部署动作依次是：登录 registry、拉取本次 tag、以新 tag 重建 server 容器。容器以 `restart: unless-stopped` 运行，宿主重启后自行恢复。容器监听宿主 8443，与现状及 etcd 中的 `public_url: http://coding.local:8443`、`webauthn.rp_id: coding.local` 一致，因此浏览器侧的会话 Cookie 与通行密钥绑定不受这次改造影响。

## 成功判据与失败行为

部署后流水线轮询 `http://127.0.0.1:8443/v1/healthz`，直到响应的 `data` 同时满足 `status=ok`、`db_ping=true`、`redis=true`，或超时。健康检查未在超时内通过即判定部署失败，流水线为红。

失败时不做自动回滚：容器会因 `restart: unless-stopped` 反复重启，环境处于可观测的坏状态而不是被悄悄换回旧版本。这是刻意的——dev 环境的价值在于暴露问题，静默回滚会让人误以为这个 commit 是好的。排查入口是容器日志。

镜像按 tag 累积在目标机上，不自动清理。目标机根盘剩余 75G（已核实），单个 server 镜像 64MB，短期内不构成压力；清理策略不属于本轮。

## 一次性迁移（人工执行）

本轮交付一份步骤清单，由维护者在目标机上执行一次，之后流水线才能接管。清单需覆盖：停掉 tmux 里的裸进程以释放 8443、建立部署目录并放入引导配置与 JWT 密钥、把 etcd 中 `/config/dev/agentre-server/server` 的 JWT 路径改为容器路径、把 runner 的 SSH 公钥加入目标机 `authorized_keys`、在 Gitea 配置所需 secret、创建并推送 `dev` 分支。

清单本身是文档产物，不是流水线的一部分。

## Out of scope

- **agentred 的容器化与其 dev 流水线** —— 属于 `agentre` 仓库的独立子系统，另起一份 spec，与本轮无硬依赖。
- **反向代理与 HTTPS** —— `/root/agentre-caddy/Caddyfile`（`coding.local` → 127.0.0.1:8443，internal TLS）存在但机器上没装 caddy（已核实）。dev 继续以明文 8443 直接对外，`insecure_cookies: true` 保持不变。
- **镜像清理、多架构构建、dev 环境的自动回滚。**

## Testing decisions

CI 编排与 compose 文件没有值得一写的单元测试语义——针对 YAML 断言自身内容的测试是同义反复。本轮的验证放在流水线内部，作为部署链路自带的门禁：

| Seam | What it verifies | Prior art |
|---|---|---|
| 流水线内 `docker compose config` 校验 | compose 文件语法与变量插值可解析；`.env` 缺项导致的空镜像 tag 在部署前就失败，而不是在目标机上炸 | 无 |
| 流水线内 `/v1/healthz` 轮询 | 新容器真的起来了且 DB / Redis 连通；这是「部署成功」的唯一判据 | `deploy/README.md` 已把这条响应作为 compose 部署的验收方式 |
| 既有 `go test -race ./...` 与 golangci-lint | 代码门禁，与 `main` 同口径 | `.gitea/workflows/deploy.yaml` |

无法自动化的部分：**现有 Gitea runner 到 192.168.8.188 的 SSH 可达性目前是用户陈述，未经核实**（我无 Gitea 实例访问权限，无法查询 runner 所在主机）。首次 `push dev` 的运行结果即是对它的验证；若不通，方案退回「在 `coding.local` 上安装 act_runner」，此时决策 6 及部署方式一节需要重新走审批。一次性迁移清单的正确性同样只能由那一次真实执行来验证。

## Open questions

（无）
