# 部署

```
deploy/
  Dockerfile            镜像：前端和后端都在里面构建，产物是单个静态二进制
  docker-compose.yml    单机部署：server + PostgreSQL + Redis
  config.docker.yaml    compose 用的配置
  helm/                 Kubernetes 部署
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

然后起起来：

```bash
docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:8443/v1/healthz
```

`{"db_ping":true,"redis":true}` 就是好了，浏览器打开 <http://localhost:8443> 能看到界面。

数据落在仓库根的 `data/pg` 和 `data/redis`，删掉就等于重置。

### 要改配置

改 `deploy/config.docker.yaml` 然后 `docker compose -f deploy/docker-compose.yml up -d`。
常改的几处：

| 想做什么 | 改哪里 |
| --- | --- |
| 换数据库/Redis 地址 | `db.dsn`、`redis.addr` |
| 对外域名（拼 OAuth 回调和设备验证链接用） | `server.public_url` |
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

容器里配置文件的位置是 `/app/configs/config.yaml`，想用自己的就盖掉它：

```bash
docker run --rm -p 8443:8443 \
  -v "$PWD/my-config.yaml:/app/configs/config.yaml:ro" \
  -v "$PWD/runtime/keys:/keys:ro" \
  agentre-server:local
```

## Kubernetes 部署

`helm/` 下是 chart，只部署服务本身——PostgreSQL、Redis、etcd 都用集群里现成的。

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
| `db` | PostgreSQL 连接串 |
| `redis` | Redis 地址 |
| `http` | 监听地址，端口要和 chart 的 `containerPort` 一致 |
| `server` | 域名、会话、JWT 密钥、GitHub OAuth。密钥类的都在这里面 |

`trace` 可选，不写就是不开链路追踪。每个键的内容照着仓库根的
`configs/config.example.yaml` 填。

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

### etcd 那段配置的格式

ConfigMap 里 etcd 的地址写了两遍——一遍摊平的，一遍套在 `config:` 底下。看着像冗余，
但两遍都得留：不同版本的 cago 认的格式不一样，只写一种，换版本的时候会**悄悄**解析成
空地址，然后连不上 etcd 却不报错。等 cago 升级到新版本之后可以只留摊平的那份。

## 自动发布

推分支到 Gitea 会自动构建镜像并发布，规则：

| 分支 | 环境 | 域名 |
| --- | --- | --- |
| `main` | prod | `app.agentrehub.com` |
| `release/*` | pre | `pre.app.agentrehub.com` |
| `test/*` | test | `test.app.agentrehub.com` |

生产的资源配额高一些并开自动扩缩，其余环境单副本。镜像 tag 是 `<环境>.<短 commit>`。

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

两个容易踩的：

- **加了 `.gitea/workflows/` 之后，Gitea 就不看 `.github/workflows/` 了**，两边不合并。
  所以 GitHub 上的 `ci.yml` 只在 GitHub 生效，Gitea 这边只跑发布流水线里的门禁。
- 流水线里的 `uses:` 都写成了 `actions/*`，这是当前这台 Gitea 实例的动作镜像位置。
  **换一台实例可能要改回 `docker/*` 之类的上游名字。**

## 起不来的时候

```bash
# docker
docker compose -f deploy/docker-compose.yml logs -f server
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
