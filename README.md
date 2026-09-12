# Agentre Server

SaaS backend for the Agentre project — accounts, devices, and RFC 8628 Device Flow.

## Quick start (Docker)

```bash
cp deploy/.env.example deploy/.env                   # 选填，各项都有缺省值

docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:8443/v1/healthz
```

改配置、部署到 Kubernetes、自动发布，见 [deploy/README.md](deploy/README.md)。

## Local dev

```bash
cp configs/config.example.yaml configs/config.yaml   # gitignored runtime 配置
# 把 db.dsn / redis.addr 指向你自己的 MySQL + Redis

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

## License

GPL-3.0 —— 见 [`LICENSE`](LICENSE)。仓库里 `agentre/frontend/packages/` 下被本仓消费的
共享前端包同为 GPL-3.0。
