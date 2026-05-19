# CLAUDE.md

Agent guidance for `agentre-hub`.

## Project Overview

AgentRe Hub — SaaS backend (Go 1.26, cago framework). Accounts + RFC 8628 Device Flow.
PostgreSQL 16 + Redis 7. React + Vite + shadcn frontend embedded via `//go:embed`.
Sibling repo: `/Users/codfrm/Code/agentre/agentre`（桌面端，本仓库**不依赖**）。

## Common Commands

```bash
make dev        # vite + hub 并行
make build      # 前端 build → embed → go build
make test       # go test -race ./...
make test-cover # coverage html
make lint       # golangci-lint
make mock       # go generate
make docker     # 构建 agentre/hub:0.1
```

## Layout（参 spec §1）

```
cmd/hub/main.go
internal/{bootstrap,api,controller,service,repository,model/entity,middleware,pkg,task,web,buildinfo}/
migrations/
frontend/
configs/config.yaml
docker-compose.yml
Dockerfile
```

## Layered conventions (cago)

- Entity → 充血：`Check(ctx)`、`IsActive()` 放 entity；service 只编排
- Repository → interface + `Register/accessor` + `db.Ctx(ctx)`；事务 `db.WithContextDB(ctx, tx)`
- Service → interface + 单例 + 私有 impl；依赖 repo interface（mockgen）
- Controller → 薄层，验参 → 调 service → 返
- Error / i18n → `pkg/code` 段位 30000+，`i18n.NewError(ctx, code.Xxx)`

## TDD（red → green → refactor）

- Repository：sqlmock，**禁起真 PG**（**唯二例外**：`migrations/*_test.go`、`bootstrap/cago_test.go`）
- Service：mockgen 注入 repo mock
- Controller：`muxtest.TestMux`
- 集成：`internal/integration/*`（build tag `integration` 或 `jwttestkeys`）

## Storage

- PostgreSQL：业务数据，源数据
- Redis：session、oauth_state、jwt blacklist、rate limit；TTL 自然过期
- 不落磁盘 config（cago 内置 yaml + env override 由 `bootstrap.LoadHubConfig` 手动注入）

## 错误处理

- OAuth 标准错误：`device_svc.OAuthError` → `device_ctr.oauthErrToHTTP` → `middleware.AttachOAuthErrorFields` 注入 RFC 8628 字段
- 业务错误：`i18n.NewError(ctx, code.Xxx)`

## Conventions

- Module path: `agentre-hub`
- Commits: gitmoji
- Linter: golangci-lint v2
- 不动 `migrations/*` 既有文件；新增补丁迁移

## 关联文档

- Design spec: 见 sibling agentre 仓库 `docs/superpowers/specs/2026-05-19-hub-foundation-design.md`
- 纲领 spec: `docs/superpowers/specs/2026-05-19-hub-multi-client-design.md`
