# AgentRe Server

SaaS backend for the AgentRe project — accounts, devices, and RFC 8628 Device Flow.

## Quick start (Docker)

```bash
mkdir -p runtime/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out runtime/keys/jwt.key
openssl rsa -in runtime/keys/jwt.key -pubout -out runtime/keys/jwt.pub

cp .env.example .env                                 # 填 GitHub OAuth App 凭据
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env

docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:8443/v1/healthz
```

改配置、部署到 Kubernetes、自动发布，见 [deploy/README.md](deploy/README.md)。

## Local dev

```bash
cp configs/config.example.yaml configs/config.yaml   # gitignored runtime 配置
# 把 db.dsn / redis.addr 指向你自己的 PostgreSQL + Redis
make dev
```

`make dev` 同时跑 server（:8443）+ vite（:5174 proxy /v1）。

## GitHub OAuth App

1. GitHub Settings → Developer settings → OAuth Apps → New OAuth App
2. Homepage URL：`https://<your-server>`
3. Callback URL：`https://<your-server>/v1/auth/oauth/github/callback`
4. 复制 Client ID / Secret 到 `.env`

## Architecture

改代码前先读 [`AGENTS.md`](AGENTS.md) 和 [`docs/`](docs/README.md)。

基础设计 spec：[`../agentre-hub/docs/superpowers/specs/2026-06-16-hub-foundation-design.md`](../agentre-hub/docs/superpowers/specs/2026-06-16-hub-foundation-design.md)
