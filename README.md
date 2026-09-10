# AgentRe Server

SaaS backend for the AgentRe project — accounts, devices, and RFC 8628 Device Flow.

## Quick start (Docker)

```bash
cp deploy/.env.example deploy/.env                   # 选填，各项都有缺省值

docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:8443/v1/healthz
```

compose 默认 `JWT_AUTO_GENERATE=1`：容器首次启动时 `/keys` 里没有私钥就自己生成一把
RSA-2048（kid `local-1`），落在具名卷 `deploy_keys` 里，**不需要手工生成密钥**。密钥
要随部署持久保留，丢了等于所有设备和浏览器重新登录；多副本必须把它设成 0 并自备密钥。

改配置、部署到 Kubernetes、自动发布，见 [deploy/README.md](deploy/README.md)。

## Local dev

```bash
cp configs/config.example.yaml configs/config.yaml   # gitignored runtime 配置
# 把 db.dsn / redis.addr 指向你自己的 MySQL + Redis

# 非容器路径从文件读配置，而 config.example.yaml 里的 server.jwt.keys 是生产路径
# （/etc/agentre-server/keys/...）。本地生成一对密钥，再把 server.jwt.keys[0] 的
# private_key_pem_path / public_key_pem_path 指向它们；或者改成
# runtime/keys/jwt.{key,pub} 并 export AGENTRE_SERVER_JWT_AUTO_GENERATE=1，让服务
# 启动时自己补一把。
mkdir -p runtime/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out runtime/keys/jwt.key
openssl rsa -in runtime/keys/jwt.key -pubout -out runtime/keys/jwt.pub

make dev
```

`make dev` 同时跑 server（:8443）+ vite（:5174 proxy /v1）。服务也支持
`--config <path>`；显式路径失败时不回退，未传参数仍使用 `configs/config.yaml`。

真实 MySQL/Redis 浏览器冒烟的唯一自动入口是 `make e2e`；本地人工验证和
scratch 工作流见 [`e2e/README.md`](e2e/README.md)。

## GitHub OAuth App

1. GitHub Settings → Developer settings → OAuth Apps → New OAuth App
2. Homepage URL：`https://<your-server>`
3. Callback URL：`https://<your-server>/v1/auth/oauth/github/callback`
4. 把 Client ID / Secret 写进 `deploy/.env` 的 `GH_CLIENT_ID` / `GH_CLIENT_SECRET`

## Architecture

改代码前先读 [`AGENTS.md`](AGENTS.md) 和 [`docs/`](docs/README.md)。

基础设计 spec：[`../agentre-hub/docs/superpowers/specs/2026-06-16-hub-foundation-design.md`](../agentre-hub/docs/superpowers/specs/2026-06-16-hub-foundation-design.md)
