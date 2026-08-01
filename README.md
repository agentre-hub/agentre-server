# AgentRe Server

SaaS backend for the AgentRe project — accounts, devices, and RFC 8628 Device Flow.

## Quick start (Docker)

```bash
cp .env.example .env
# 生成 SESSION_SECRET / JWT_PRIVATE_KEY_PEM；填 GitHub OAuth App 凭据
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out server.key
echo "JWT_PRIVATE_KEY_PEM=\"$(cat server.key)\"" >> .env
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env

docker compose up -d
curl http://localhost:8443/v1/healthz
```

## Local dev

```bash
# pre-req：本机有 postgres:5432 / redis:6379；或起 docker compose up -d pg redis
cp configs/config.example.yaml configs/config.yaml   # gitignored runtime 配置
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
