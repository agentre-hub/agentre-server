# agentre-server dev 环境自动部署

> Status: Approved
> Owner: agentre maintainers
> Last updated: 2026-09-02

**Objective:** 向 Gitea 推送 `dev` 分支后，`coding.local` 上的 dev server 在无人介入的情况下被替换为该 commit 的构建产物，并以健康检查通过作为部署成功的判据。

> **Amendment 2026-09-02（本文件已按此修订）：以速度换严格。** 用户决定 dev 链路不再跑 lint / test，镜像也不再在 CI 里构建：改为在 runner 上 `make build` 出静态二进制、`scp` 到目标机，再在目标机上用 `deploy/Dockerfile.dev` 做一次只有一层 `COPY` 的 build（实测 3.6 秒），打成固定的本地 tag。原方案里每次部署都是一个全新的完整 `docker build`，Go build cache 与 pnpm store 一次都复用不上，一次推送要等几分钟；dev 的价值是「推上去看看效果」，这个等待比它挡下的问题更贵。受影响的是 user story 2、decision 2 与 decision 6 的后半段，下文相应各节已改写。原始取舍保留在本说明里，没有另起一份 spec。代价明说：dev 跑的东西不再有 registry 里可追溯的 digest（只剩二进制里 ldflags 钉的版本号与本地镜像 ID），且 lint / test 只在 GitHub 侧 `ci.yml` 与本地 `make test` 上把关。

**Hard invariant:** `main` / `release/*` / `test/*` 的现有 k8s 发布链路行为不变；dev 环境沿用现有的外部 etcd / MySQL / Redis，既有 `agentre_server_dev` 数据不迁移、不重建。

## Problem

1. **dev 环境没有部署链路，且当前是停的。**（已核实）目标机 `coding.local`（192.168.8.188）上 server 以裸二进制 `./bin/server` 的形式从 tmux 窗口启动，源码目录 `/root/code/agentre/agentre-server`。`ss -ltnp` 显示 8443 无监听，tmux 只剩一个 `zsh` 窗口——进程已经不在了。每次更新都要人工上机 pull、构建、重开 tmux 窗口。
2. **目标机没有 Go 工具链，构建无法在机器上原地完成。**（已核实）机器上 `go` 不在 PATH，`/usr/local/go` 不存在；只有 Node 24（nvm）、Docker 29.2.1、Compose v5.1.0。因此产物必须在别处构建后送达。
3. **现成的 `deploy/docker-compose.yml` 不适用于 dev。**（已核实）它会额外拉起 MySQL 9.7.2 与 Redis 7 并把数据落在仓库内的 `data/`，而 dev 的库是外部的 `192.168.8.141:3306/agentre_server_dev` 与 `192.168.8.141:6379`，直接套用等于把现有 dev 数据旁路掉。
4. **etcd 里的 dev 配置写着宿主绝对路径的 JWT 私钥。**（已核实）`/config/dev/agentre-server/server` 的 `jwt.keys[0].private_key_pem_path` 是 `/root/code/agentre/agentre-server/runtime/keys/jwt.key`。容器内不存在该路径，不处理会在启动时以 `read pem ...: no such file or directory` 失败。
5. **Gitea 上没有 `dev` 分支。**（已核实）`git ls-remote --heads gitea` 只有 `main` 与 `chore/frontend-deps-for-shared-ui`。

## Actors and user stories

1. 作为在本机开发的维护者，我希望 `git push gitea dev` 之后 dev 环境自动变成这个 commit，这样我不必再上机手工构建和重启。
2. 作为维护者，我希望推上去之后几十秒内就能看到效果，这样 dev 环境是拿来验证想法的而不是拿来等的；门禁由 GitHub 侧 `ci.yml` 与本地 `make test` 负责。
3. 作为维护者，我希望部署失败时流水线是红的且 dev 环境保持在旧版本，这样我不会以为部署成功了却在对着一个起不来的服务排查。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | 新建 `.gitea/workflows/dev.yaml`，不改动 `deploy.yaml` | dev 与 k8s 链路的差异面很大（不需要 QEMU / 多架构、不需要 kubeconfig / helm / TLS secret），且现有 `deploy.yaml` 是正在服务 prod 的链路。隔离成独立文件后，dev 的任何改动都不可能影响 prod 发布。Rejected: 在 `deploy.yaml` 里加分支条件与两个 conditional deploy job——省掉约 40 行重复，但把 prod 发布置于 dev 迭代的风险之下 |
| 2 | dev 的镜像在目标机上现打：runner 只出静态二进制，目标机用 `deploy/Dockerfile.dev` 做一层 `COPY` | 用户决定。完整 `docker build` 每次都在新容器里从零跑 pnpm install + go build，两个缓存都用不上；放回 runner 后 setup-go 的 module/build cache 与 pnpm store 都能命中，目标机那一层 COPY 是秒级的，也不用 push/pull。Rejected: 复用 `deploy/Dockerfile` 构建并推 `dev.<short-sha>`（本轮原方案）——产物有 digest，但每次部署分钟级。Rejected: 二进制 bind mount 进固定镜像——连那 3.6 秒也省了，但单文件挂载绑 inode、目录挂载又让「镜像里是什么」不再自洽 |
| 2a | dev 镜像用固定 tag `agentre-server:dev`，不带 short-sha | 带 sha 就得把 tag 写进 `.env` 再让 compose 去读，多一处要同步的状态；跑的是哪个 commit 看启动首行日志。目标机是 containerd snapshotter（已核实），重打同名 tag 不留悬空镜像，不需要 prune |
| 3 | dev compose 只声明 server 一个服务，配置仍 `source: etcd` | 用户决定。既有 dev 数据在 141 那台机上且已持久化，配置改动不需要发版，与 k8s 链路的配置读取方式保持同构。Rejected: compose 自带 MySQL + Redis——dev 环境自包含，但要先迁移 `agentre_server_dev` 的既有数据，且 dev 与 prod 的配置来源分叉 |
| 4 | 引导配置、JWT 密钥、compose 的 `.env` 都是机器本地文件，不进仓库 | 仓库已经把 `configs/config.yaml` 列入 `.gitignore`（第 21 行），即「引导配置属于机器不属于代码」是既定约定；且引导配置含内网 etcd 端点。Rejected: 提交 `deploy/config.dev.yaml`——违反既有约定并把内网拓扑写进公开仓库 |
| 5 | 把 etcd 里 dev 的 JWT 路径改成容器路径 `/keys/jwt.key`，由 compose 只读挂载 | 与 `deploy/README.md` 描述的 k8s 约定（`/keys/<kid>.key`）一致。Rejected: 按宿主原路径 `/root/code/agentre/agentre-server/runtime/keys` 挂进容器——能跑，但把容器绑死在机器上那份 git checkout 的存在性上 |
| 6 | 部署走 SSH：runner 构建产物后 SSH 送到目标机，再 compose up（修订后不再经过 registry） | 用户决定，且用户确认现有 runner 能路由到 192.168.8.188。Rejected: 在 `coding.local` 上装 act_runner——免 SSH 密钥与 registry 往返，但要在目标机常驻一个构建服务并占用其 CPU / 磁盘 |
| 7 | 首次切换（停 tmux 裸进程、建目录、改 etcd、配 SSH 密钥）由人工执行一次，不进流水线 | 用户决定。这些是一次性且不可逆的动作，放进流水线只有第一次有意义，之后永远是死代码。Rejected: 部署脚本里带接管逻辑 |

## 触发与门禁

推送到 Gitea 的 `dev` 分支触发 dev 流水线。除此之外没有别的触发源：`main` / `release/*` / `test/*` 仍然只被 `deploy.yaml` 接管，两个 workflow 的分支集合不相交，同一次推送不会同时跑两条链路。

dev 链路不设门禁：不跑 lint，也不跑测试。唯一挡在部署前的是构建本身——编不过就没有产物可送，流水线为红且 dev 环境停留在上一个成功版本。lint 与 Go / 前端测试由 GitHub 侧的 `ci.yml` 与本地 `make test` 负责，`main` / `release/*` / `test/*` 的门禁不受影响。

## 构建

在 runner 上跑与本地同一条 `make build`：`pnpm install --frozen-lockfile && pnpm build` → 拷进 `internal/web/dist` → `go build`，产物是单个静态二进制（`CGO_ENABLED=0`）。`VERSION` 与 `COMMIT` 在命令行覆盖，取 `dev.<short-sha>` 与 short sha，使服务启动首行日志能对回具体 commit。`GOOS` / `GOARCH` 显式钉成 `linux/amd64`（目标机已核实为 x86_64），不跟随 runner 架构。

镜像在目标机上打：`deploy/Dockerfile.dev` 只有 `COPY server /app/server`，其余（基础镜像、`WORKDIR /app`、`USER 65532:65532`、`ENTRYPOINT`）与 `deploy/Dockerfile` 的运行时 stage 一致，唯一刻意的差异是不带占位配置——dev 一定挂着机器本地的引导配置。构建上下文只给部署目录下的 `bin/`，因为同目录还有 `config.yaml` 与 `keys/jwt.key`。

两处缓存是这条链路快起来的前提：`setup-go` 按 `go.sum` 恢复 module cache 与 `~/.cache/go-build`；pnpm 的 store 落在工作区内、由 `actions/cache` 按 `pnpm-lock.yaml` 缓存。缓存未命中只是慢一点，不使流水线失败。

## 部署

部署以 SSH 方式对 `coding.local` 执行，凭据来自 Gitea secret，流水线不在日志中回显私钥。registry 不再参与这条链路，因此目标机上也不再需要 `docker login`。

目标机上存在一个部署目录，其中 compose 文件与二进制由流水线从 runner 同步覆盖，其余文件是机器本地资产、流水线只读不写：

- **compose 文件** —— 每次部署由流水线覆盖，保证机器上跑的就是这个 commit 声明的编排。
- **二进制与 `Dockerfile.dev`** —— 每次部署由流水线覆盖；`bin/` 同时是 `docker build` 的整个上下文。
- **`.env`** —— 流水线不再读写它，dev 不再需要这个文件。
- **引导配置** —— `env: dev`、`source: etcd`、指向 `192.168.8.141:2379`，只读挂载到容器的配置路径。
- **JWT 密钥对** —— 只读挂载到容器的 `/keys`。

部署动作依次是：把二进制传成临时名、在目标机上改名替换、`docker build` 打成 `agentre-server:dev`、以 `--force-recreate` 重建 server 容器。传临时名再改名，是为了让半路失败时 `bin/` 里留着的仍是上一个完整的二进制；`--force-recreate` 在 tag 固定的情况下是保险（镜像 ID 变了 compose 本来就会重建），省下的一两秒不值得换来「部署全绿而跑的还是上一版」。容器跑成 uid 65532——与 `deploy/Dockerfile` 的 `USER 65532:65532` 一致，机器上那份 `config.yaml` 与 `keys/` 正是按这个 uid 授权的。容器以 `restart: unless-stopped` 运行，宿主重启后自行恢复。容器监听宿主 8443，与现状及 etcd 中的 `public_url: http://coding.local:8443`、`webauthn.rp_id: coding.local` 一致，因此浏览器侧的会话 Cookie 与通行密钥绑定不受这次改造影响。

## 成功判据与失败行为

部署后流水线轮询 `http://127.0.0.1:8443/v1/healthz`，直到响应的 `data` 同时满足 `status=ok`、`db_ping=true`、`redis=true`，或超时。健康检查未在超时内通过即判定部署失败，流水线为红。

失败时不做自动回滚：容器会因 `restart: unless-stopped` 反复重启，环境处于可观测的坏状态而不是被悄悄换回旧版本。这是刻意的——dev 环境的价值在于暴露问题，静默回滚会让人误以为这个 commit 是好的。排查入口是容器日志。

目标机上不再按 tag 累积 dev 镜像：`agentre-server:dev` 每次重打同一个 tag，containerd 的镜像存储不会留下悬空镜像（已核实）。旧的 `dev.<short-sha>` 镜像是历史遗留，清理不属于本轮。

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
| 流水线内 `docker compose config` 校验 | compose 文件语法与变量插值在目标机上可解析，而不是等到 `up` 才炸 | 无 |
| 流水线内 `/v1/healthz` 轮询 | 新容器真的起来了且 DB / Redis 连通；这是「部署成功」的唯一判据 | `deploy/README.md` 已把这条响应作为 compose 部署的验收方式 |
| 既有 `go test -race ./...` 与 golangci-lint | 代码门禁，与 `main` 同口径 | `.gitea/workflows/deploy.yaml` |

无法自动化的部分：**现有 Gitea runner 到 192.168.8.188 的 SSH 可达性目前是用户陈述，未经核实**（我无 Gitea 实例访问权限，无法查询 runner 所在主机）。首次 `push dev` 的运行结果即是对它的验证；若不通，方案退回「在 `coding.local` 上安装 act_runner」，此时决策 6 及部署方式一节需要重新走审批。一次性迁移清单的正确性同样只能由那一次真实执行来验证。

## Open questions

（无）
