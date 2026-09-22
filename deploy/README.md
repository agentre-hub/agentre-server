# 部署

`agentre-server` 将前端嵌入单个静态二进制，默认监听 `8443`，运行时不需要 Nginx。

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml`、`.env.example` | 单机 Compose（server、MySQL、Redis） |
| `Dockerfile`、`config.docker.yaml` | 生产镜像及默认配置 |
| `docker-compose.dev.yml` | dev 目标机（外部 MySQL/Redis/etcd） |
| `Dockerfile.bin` | 装载流水线编好的二进制，两条 Gitea 流水线共用 |
| `helm/` | Kubernetes chart（外部 MySQL/Redis/etcd） |

## Compose 单机

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:8443/v1/healthz
```

健康检查应返回 `data.status=ok`、`data.db_ping=true`、`data.redis=true`。数据位于仓库根的 `data/mysql`、`data/redis`，删除即清空。Compose 使用 MySQL `9.7.2`；升级前备份并确认官方升级路径。MySQL `max_allowed_packet` 不要低于 `8 MiB`。

配置文件放在 `deploy/`：`.env` 负责镜像、端口、公开 URL、数据库、Redis、OAuth 等变量；`config.docker.yaml` 负责其余配置并挂载到 `/app/configs/config.yaml`。变量模板见 [`.env.example`](.env.example)。常用变量：`SERVER_IMAGE`、`SERVER_PUBLIC_URL`、`DB_DSN`、`REDIS_ADDR`、`REDIS_PASSWORD`、`GH_CLIENT_ID`、`GH_CLIENT_SECRET`、`TRUSTED_PROXIES`。公开 URL 必须是浏览器实际访问地址；仅在前置反代时设置 `TRUSTED_PROXIES`。

GitHub OAuth 回调地址：`<SERVER_PUBLIC_URL>/v1/auth/oauth/github/callback`。

## 单容器

已有数据库和 Redis 时可直接运行（数据库需预先创建，服务会执行迁移）：

```bash
docker run -d --name agentre-server -p 8443:8443 \
  -e AGENTRE_SERVER_DB_DSN="user:pass@tcp(db:3306)/agentre?charset=utf8mb4&parseTime=True&loc=Local&interpolateParams=true&timeout=5s&readTimeout=60s&writeTimeout=60s" \
  -e AGENTRE_SERVER_REDIS_ADDR='redis:6379' \
  -e AGENTRE_SERVER_PUBLIC_URL='http://host:8443' \
  ghcr.io/agentre-hub/agentre-server:latest
curl http://localhost:8443/v1/healthz
```

镜像默认读取 `/app/configs/config.yaml`；可用环境变量覆盖 `db.dsn`、`redis.*`、`server.public_url`、`server.oauth.github.*`、`server.trusted_proxies`。整份替换配置可挂载到该路径，或追加 `--config /path/to/config.yaml`。本地构建：`make docker`。

## Dev 目标机

Gitea 的 `dev` 流水线在 runner 执行 `make build`，通过 runner 自带的 OpenSSH 将二进制和编排文件放到 `/srv/agentre-dev/`，目标机用 `Dockerfile.bin` 构建固定镜像 `agentre-server:dev`。该链路不经过 registry，也不创建 MySQL/Redis/etcd；dev 流水线不校验目标机 host key，严格环境应改为由管理员预置 `known_hosts`，不要在流水线里动态扫描后立即信任。

一次性准备：创建 `/srv/agentre-dev/config.yaml`（`env: dev`、`source: etcd`），确保容器用户 `65532` 可读；将 etcd 的 `/config/dev/agentre-server/logger` 中 `logFile.enable` 设为 `false`；配置 Gitea secret `DEV_SSH_KEY`。

```bash
cd /srv/agentre-dev
docker build -f Dockerfile.bin -t agentre-server:dev bin
docker compose -f docker-compose.dev.yml up -d --force-recreate
docker compose -f docker-compose.dev.yml logs -f server
curl http://<目标机>:8443/v1/healthz
```

替换 `bin/server` 后必须重新构建。业务配置在 etcd，修改后无需重新部署。

## Kubernetes / Helm

```bash
helm upgrade --install agentre-server ./deploy/helm \
  --set image.repository=your-registry/agentre-server --set image.tag=latest \
  --set appConfig.env=prod --set-string etcdConfig.endpoints[0]=etcd.example:2379 \
  --set-string etcdConfig.password='***'
```

Chart 只部署 server。除 ConfigMap 中的 etcd 引导信息外，其余配置必须预先写入 `/config/<env>/agentre-server/`；缺键不会回退默认值。用 `helm status`、`kubectl get pods` 和 `/v1/healthz` 验证。模板见 [`helm/values.yaml`](helm/values.yaml)。

Ingress 默认下发 HSTS `max-age=31536000; includeSubDomains`（`ingress.hsts`，经 `configuration-snippet` 的 `more_set_headers`，需要控制器开着 `allow-snippet-annotations`；置空则退回控制器自己的缺省）。端口转发子域要挂在同一个 Ingress 上：`--set-string ingress.forwardHost='*.fw.agentrehub.com' --set-string ingress.forwardTlsSecretName=<通配证书 secret>`，并在 etcd 里配 `server.port_forward.base_domain`（与 host 去掉 `*.` 一致）；两者都不配则不提供转发。通配证书（DNS-01）与通配 DNS 是部署前提，不由 chart 创建。dev 上的转发域是 `*.fw.agentre.docker.local`，由 docker.local 上的 AdGuard 解析，同样要在 etcd 的 dev 配置里写 `base_domain`。

## 镜像与流水线

官方镜像：`ghcr.io/agentre-hub/agentre-server`。`latest`、`vX.Y.Z`、`sha-<commit>` 来自 release workflow；`nightly`、`nightly-YYYYMMDD` 来自 nightly workflow。Gitea 的 `Deploy`（k8s）与 `Deploy dev` 都在 runner 上 `make build`，镜像用 `Dockerfile.bin` 只做一层 COPY；前者架构跟随 runner，后者钉 `linux/amd64`。触发条件和 secrets 以对应 workflow 为准。

## 排障

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f server
kubectl describe pod <pod>
kubectl logs <pod>
```

`healthz` 不通过时检查 MySQL/Redis 地址、凭据及日志；`load config: context deadline exceeded` 检查 etcd 网络、端点和密码；`etcd ... not found` 检查配置键；登录失效时检查公开 URL、反代和 `TRUSTED_PROXIES`。E2E 见 [`../e2e/README.md`](../e2e/README.md)。
