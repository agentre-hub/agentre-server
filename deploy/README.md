# 部署

```
deploy/
  Dockerfile              镜像：前端和后端都在里面构建，产物是单个静态二进制
  docker-compose.yml      单机部署：server + MySQL + Redis
  docker-compose.dev.yml  dev 环境：只有 server，MySQL/Redis/etcd 用外部现成的
  config.docker.yaml      compose 用的配置
  helm/                   Kubernetes 部署
```

服务是一个二进制，前端 SPA 用 `go:embed` 打进去了，所以运行时不需要 nginx，
也不需要挂静态文件目录。默认监听 8443。

## Docker 单机部署

最省事的一种，适合自用或者小规模。

先生成 JWT 密钥（签发设备令牌用的，没有它起不来）：

```bash
mkdir -p runtime/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out runtime/keys/jwt.key
openssl rsa -in runtime/keys/jwt.key -pubout -out runtime/keys/jwt.pub
```

`deploy/config.docker.yaml` 把这把密钥登记为 `local-1`。生产环境用 `server.jwt.keys`
维护验签 key ring，`active_kid` 指向唯一用于签发的项；旧项只保留
`public_key_pem_path`，用于不打断仍在 15 分钟有效期内的访问令牌：

```yaml
server:
  jwt:
    active_kid: "2026-09-b"
    keys:
      - kid: "2026-08-a"
        public_key_pem_path: "/keys/2026-08-a.pub"
      - kid: "2026-09-b"
        private_key_pem_path: "/keys/2026-09-b.key"
        public_key_pem_path: "/keys/2026-09-b.pub"
```

正常轮换先部署含新旧公钥、以新 key 签发的配置；等待至少
`access_ttl + 60s` 后再删除旧项。若旧私钥泄漏，不等待：立刻从 `keys` 删除旧项、
切换 `active_kid` 并滚动部署。服务端随即拒绝旧 `kid`，已登录 agentred 每分钟刷新
一次 `/v1/keys`，在刷新成功后也会删除本地旧公钥；刷新失败时保留最后一份有效集合。
完全离线的 agentred 无法获知服务端状态变化，仍会保留旧公钥；私钥泄漏时必须把这些
节点视为尚未完成处置，待其重新连上并成功刷新 key set 后才算废弃生效。

然后起起来：

```bash
docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:8443/v1/healthz
```

响应里的 `data` 同时满足
`{"status":"ok","db_ping":true,"redis":true}` 就是好了，浏览器打开
<http://localhost:8443> 能看到界面。

数据落在仓库根的 `data/mysql` 和 `data/redis`，删掉就等于重置。

Compose 固定使用 MySQL 9.7.2。升级 MySQL 前先做逻辑备份，并按 MySQL 官方
升级路径检查目标版本是否支持直接读取当前数据目录；不要让不兼容的大版本
直接复用 `data/mysql`。

### 要改配置

改 `deploy/config.docker.yaml` 后重启已在运行的服务，让进程重新读取 bind mount
里的配置：

```bash
docker compose -f deploy/docker-compose.yml restart server
```

第一次启动整套服务仍使用上面的 `up -d`。
常改的几处：

| 想做什么 | 改哪里 |
| --- | --- |
| 换数据库/Redis 地址 | `db.dsn`、`redis.addr` |
| 对外域名（拼 OAuth 回调和设备验证链接用） | 根目录 `.env` 的 `SERVER_PUBLIC_URL`（Compose 环境变量覆盖 yaml） |
| 域名变更后的通行密钥绑定 | `server.webauthn.rp_id` 和 `server.webauthn.origins` |
| 上了 HTTPS 之后 | `server.insecure_cookies` 改成 `false` |
| 日志详细一点 | `logger.level` 改成 `debug` |

GitHub 登录要在 <https://github.com/settings/developers> 建一个 OAuth App，回调地址填
`<你的域名>/v1/auth/oauth/github/callback`，然后把 id 和 secret 写进仓库根的 `.env`：

```bash
GH_CLIENT_ID=xxx
GH_CLIENT_SECRET=xxx
SESSION_SECRET=$(openssl rand -base64 32)
SERVER_PUBLIC_URL=https://your-domain
```

### 只要个镜像

```bash
make docker          # 打成 agentre/server:0.1，带上当前 commit 号
```

镜像里的地址都能换，内网环境下可以指到自己的镜像源：

```bash
docker build -f deploy/Dockerfile -t agentre-server:local \
  --build-arg GO_IMAGE=my-mirror/golang:1.26-alpine \
  --build-arg GOPROXY=https://goproxy.cn,direct \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
```

可以换的有 `NODE_IMAGE`、`GO_IMAGE`、`RUNTIME_IMAGE`、`GOPROXY`、`NPM_REGISTRY`、
`VERSION`、`COMMIT`，不传就用上游默认值。

容器默认读取 `/app/configs/config.yaml`，想用自己的就盖掉它：

```bash
docker run --rm -p 8443:8443 \
  -v "$PWD/my-config.yaml:/app/configs/config.yaml:ro" \
  -v "$PWD/runtime/keys:/keys:ro" \
  agentre-server:local
```

服务也接受 `--config <path>`。显式路径无效时直接失败且不回退；不传时保持上述
默认路径。E2E 专库配置和 CI 临时服务不属于部署配置，见
[`../e2e/README.md`](../e2e/README.md)。

## dev 环境（coding.local）

dev 跑在 `coding.local`（192.168.8.188）上，一个容器，编排是 `docker-compose.dev.yml`。

和上面的「Docker 单机部署」不是一回事，别混用：那份会额外拉起 MySQL 和 Redis 并把
数据落在仓库根的 `data/`；dev 的 MySQL、Redis、etcd 都是外部既有服务，套用那份等于
把现有的 `agentre_server_dev` 数据旁路掉。

dev 的配置和 k8s 一样放在 etcd 里，`/config/dev/agentre-server/` 下那几个键。改配置
改 etcd，不用重新部署。

### 部署目录

部署目录在机器上，不在仓库里——引导配置含内网端点，而且 `.gitignore` 本来就把
`configs/config.yaml` 排除在外：引导配置属于机器，不属于代码。

```text
/srv/agentre-dev/
  docker-compose.dev.yml   流水线每次部署覆盖
  .env                     机器本地；流水线只改写其中的 SERVER_IMAGE 一项
  config.yaml              机器本地引导配置（env: dev, source: etcd）
  keys/jwt.key jwt.pub     机器本地 JWT 密钥对
```

手动起停：

```bash
cd /srv/agentre-dev
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f server
```

上面两条都只用本地已有的镜像，不需要 registry 凭据。流水线的 registry 登录是
一次性的，`pull` 完就 `docker logout`，不在机器上留 `~/.docker/config.json`；
所以要手动 `docker compose pull` 得自己先 `docker login`。

### 第一次切换要做的（只做一次）

流水线只负责「拉新镜像 + compose up」。下面这些是一次性且不可逆的动作，没放进流水线
——放进去也只有第一次有用，之后永远是死代码。按顺序做：

1. **停掉现在的裸进程，把 8443 让出来。** dev 以前是从 tmux 窗口跑
   `/root/code/agentre/agentre-server/bin/server`：

   ```bash
   pkill -f '^\./bin/server$' || true
   tmux kill-window -t 0:agentre-server 2>/dev/null || true
   ss -ltnp | grep 8443 || echo "8443 已空出"
   ```

2. **建部署目录，放引导配置和密钥。** 引导配置直接沿用机器上现成的那份：

   ```bash
   mkdir -p /srv/agentre-dev/keys
   cp /root/code/agentre/agentre-server/configs/config.yaml /srv/agentre-dev/config.yaml
   cp /root/code/agentre/agentre-server/runtime/keys/jwt.key /srv/agentre-dev/keys/
   cp /root/code/agentre/agentre-server/runtime/keys/jwt.pub /srv/agentre-dev/keys/
   chmod 600 /srv/agentre-dev/keys/jwt.key
   ```

3. **把 etcd 里的 JWT 路径改成容器路径。** 现在 `/config/dev/agentre-server/server`
   里写的是宿主绝对路径 `/root/code/agentre/agentre-server/runtime/keys/jwt.key`，
   容器里没有这个路径，不改就是启动即挂（`read pem ...: no such file or directory`）。
   把那两条路径改成 `/keys/jwt.key` 和 `/keys/jwt.pub`，该键的其余内容原样保留，
   改法见上面「配置放在 etcd 里」。

4. **把 runner 的 SSH 公钥加进目标机的 `/root/.ssh/authorized_keys`。**
   对应的私钥就是下面要配的 `DEV_SSH_KEY`。

5. **在 Gitea 配 secret**，见下面「自动发布」的表，dev 这条链路至少要有 `DEV_SSH_KEY`。

6. **建 dev 分支并推上去**，这一推就会跑第一次部署：

   ```bash
   git checkout -b dev
   git push gitea dev
   ```

跑完确认一下：

```bash
curl -s http://coding.local:8443/v1/healthz
docker compose -f /srv/agentre-dev/docker-compose.dev.yml ps
```

`data` 里 `status`、`db_ping`、`redis` 三项都为真才算成功。**只看 `status` 没用**——
它在代码里是写死的 `"ok"`，数据库挂了它照样是 `ok`。

## Kubernetes 部署

`helm/` 下是 chart，只部署服务本身——MySQL、Redis、etcd 都用集群里现成的。

```bash
helm upgrade --install agentre-server ./deploy/helm \
  --namespace app --create-namespace \
  --set-string image.repository=your-registry/agentre-server \
  --set-string image.tag=prod.abc1234 \
  --set-string ingress.host=app.example.com \
  --set-string etcdConfig.password=xxx
```

常用的 values：

| key | 作用 |
| --- | --- |
| `image.repository` / `image.tag` | 镜像 |
| `ingress.host` | 对外域名 |
| `ingress.tlsSecretName` | 证书 Secret 的名字，置空则不开 TLS |
| `ingress.className` | ingress controller，默认 `k3s-main-nginx` |
| `ingress.annotations` | NGINX 入口注解；WebSocket 的 `proxy-read-timeout` 和 `proxy-send-timeout` 默认均为 3600 秒 |
| `appConfig.env` | `prod` / `pre` / `test`，同时决定读 etcd 的哪一份配置 |
| `etcdConfig.endpoints` / `password` | 配置中心 |
| `autoscaling.enabled` | 自动扩缩 |

### 配置放在 etcd 里

k8s 上只有四个引导键从 ConfigMap 进容器（`env`、`debug`、`source`、`etcd`），
其余全部从 etcd 的 `/config/<env>/agentre-server/` 读。改配置不用重新发版。

**第一次部署前必须先把配置写进 etcd。** 读不到的键不会回落到默认值——服务会直接起不来，
表现为 Pod 反复重启，而且不会自己好。要写的有这些：

| key | 内容 |
| --- | --- |
| `logger` | 日志级别。**`logFile.enable` 必须是 `false`**，容器是只读根文件系统，写不了文件 |
| `db` | MySQL 连接串 |
| `redis` | Redis 地址 |
| `http` | 监听地址，端口要和 chart 的 `containerPort` 一致 |
| `server` | 域名、会话、JWT 密钥、GitHub OAuth、限流、账号闸门（`account_gate.cache_ttl`）、通行密钥（`webauthn.rp_id` / `rp_name` / `origins` / `max_per_account`）。密钥类的都在这里面 |

`trace` 可选，不写就是不开链路追踪。每个键的内容照着仓库根的
`configs/config.example.yaml` 填——**那份模板是 `server` 这个键的唯一权威清单**。
chart 的 values 里没有、也不会有 `server.*`：ConfigMap 只渲染上面那四个引导键，
往 values 里加业务配置只会渲染不出来，改了却不生效比没得改更糟。新增一项业务配置
（比如通行密钥的 `webauthn`）时要做的是重新 `put` 一遍 `server` 这个键。

写一个键长这样：

```bash
etcdctl --endpoints=<etcd> --user root:<password> \
  put /config/prod/agentre-server/logger 'level: info
disableConsole: false
logFile:
  enable: false'
```

看看已经写了哪些：

```bash
etcdctl --endpoints=<etcd> --user root:<password> \
  get --prefix --keys-only /config/prod/agentre-server/
```

## 自动发布

推分支到 Gitea 会自动构建镜像并发布，规则：

| 分支 | 环境 | 域名 |
| --- | --- | --- |
| `main` | prod | `app.agentrehub.com` |
| `release/*` | pre | `pre.app.agentrehub.com` |
| `test/*` | test | `test.app.agentrehub.com` |
| `dev` | dev | `coding.local:8443`（内网单机，不上 k8s） |

前三行走 `deploy.yaml`：构建镜像后 helm 上 k8s，生产的资源配额高一些并开自动扩缩，
其余环境单副本。`dev` 走的是另一条 `dev.yaml`：构建镜像后 SSH 到 `coding.local`
执行 `docker compose`。两个 workflow 的分支集合不相交，同一次推送只会触发一条。

镜像 tag 一律是 `<环境>.<短 commit>`。

需要在 Gitea 里配好这些 secret：

| secret | 必填 | 不填时 |
| --- | --- | --- |
| `DOCKER_USERNAME`、`DOCKER_TOKEN` | 是 | — |
| `KUBE_CONFIG` | 是 | — |
| `ETCD_CONFIG_PASSWORD` | 是 | — |
| `DOCKER_REGISTRY` | 否 | `docker.io` |
| `GOPROXY` | 否 | `https://goproxy.cn,direct` |
| `NPM_REGISTRY` | 否 | `https://registry.npmmirror.com` |
| `NODE_IMAGE`、`GO_IMAGE`、`RUNTIME_IMAGE` | 否 | 上游地址 |
| `TLS_SECRET_NAME` | 否 | `agentrehub-com-tls` |
| `DEV_SSH_KEY` | dev 必填 | — |
| `DEV_SSH_HOST` | 否 | `coding.local` |
| `DEV_SSH_USER` | 否 | `root` |
| `DEV_SSH_PORT` | 否 | `22` |
| `DEV_DEPLOY_DIR` | 否 | `/srv/agentre-dev` |

`KUBE_CONFIG` 与 `ETCD_CONFIG_PASSWORD` 只有 k8s 那条链路用得到；dev 只用
`DOCKER_*` 和 `DEV_*`。

三个容易踩的：

- **加了 `.gitea/workflows/` 之后，Gitea 就不看 `.github/workflows/` 了**，两边不合并。
  所以 GitHub 上的 `ci.yml` 只在 GitHub 生效，Gitea 这边只跑发布流水线里的门禁。
- 流水线里的 `uses:` 都写成了 `actions/*`，这是当前这台 Gitea 实例的动作镜像位置。
  **换一台实例可能要改回 `docker/*` 之类的上游名字。**
- dev 的部署步骤用的是 runner 自带的 `ssh`/`scp`，没走任何 ssh-action。这台实例的
  动作镜像集是定制的，仓库里也没有 ssh-action 的先例，赌一个可能不存在的镜像不如
  用原生命令。主机密钥是首连信任（`StrictHostKeyChecking=accept-new`）。

## 起不来的时候

```bash
# docker（单机）
docker compose -f deploy/docker-compose.yml logs -f server
# docker（dev，在 coding.local 上跑）
docker compose -f /srv/agentre-dev/docker-compose.dev.yml logs -f server
# k8s
kubectl -n app logs -l app.kubernetes.io/instance=agentre-server --tail=50
```

第一行日志会打印版本号，`agentre-server prod.abc1234 (abc1234) starting`。
如果是 `dev (unknown)`，说明构建时没传版本号，对不回是哪个 commit。

| 日志 | 原因 |
| --- | --- |
| `load config: ... no such file or directory` | 配置文件没挂上，或者挂错了位置 |
| `load config: ... read-only file system` 或 `permission denied` | 引导配置缺键。服务想把默认值写回配置文件，但那是只读的 |
| `load config: context deadline exceeded` | 连不上 etcd |
| `file config key not found: <key>` | ConfigMap 里缺这个键 |
| `etcd ... not found: <key>` | etcd 里还没写这个键 |
| `read pem ...: no such file or directory` | JWT 密钥没生成或者没挂进去 |
