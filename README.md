# AgentRe Hub

SaaS backend for the AgentRe project — accounts, devices, and RFC 8628 Device Flow.

## Quick start (Docker)

```bash
cp .env.example .env
# 生成 SESSION_SECRET / JWT_PRIVATE_KEY_PEM；填 GitHub OAuth App 凭据
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out hub.key
echo "JWT_PRIVATE_KEY_PEM=\"$(cat hub.key)\"" >> .env
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

`make dev` 同时跑 hub（:8443）+ vite（:5173 proxy /v1）。

## GitHub OAuth App

1. GitHub Settings → Developer settings → OAuth Apps → New OAuth App
2. Homepage URL：`https://<your-hub>`
3. Callback URL：`https://<your-hub>/v1/auth/oauth/github/callback`
4. 复制 Client ID / Secret 到 `.env`

## Architecture

详见 `../agentre/docs/superpowers/specs/2026-05-19-hub-foundation-design.md`
