.PHONY: dev build test test-backend test-frontend test-e2e test-cover \
        lint lint-backend lint-frontend lint-e2e fmt prepare-web-dist mock migrate docker

VERSION := $(shell git describe --tags --always 2>/dev/null || echo dev)
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

dev:
	@trap 'kill 0' INT; \
	  (cd frontend && pnpm install --silent && pnpm dev) & \
	  go run ./cmd/server & wait

build:
	cd frontend && pnpm install --frozen-lockfile && pnpm build
	mkdir -p internal/web/dist
	cp -r frontend/dist/* internal/web/dist/
	CGO_ENABLED=0 go build -ldflags "-s -w \
	  -X agentre-server/internal/buildinfo.Version=$(VERSION) \
	  -X agentre-server/internal/buildinfo.Commit=$(COMMIT)" \
	  -o bin/server ./cmd/server

# 传版本号，否则镜像启动日志是 "dev (unknown)"，排障时对不回 commit
docker:
	docker build -f deploy/Dockerfile -t agentre/server:0.1 \
	  --build-arg VERSION=$(VERSION) \
	  --build-arg COMMIT=$(COMMIT) .

# 唯一的测试入口。别加 build tag——tag 会让测试被静默跳过而输出仍是绿的
test: test-backend test-frontend

prepare-web-dist:
	mkdir -p internal/web/dist
	@test -f internal/web/dist/index.html || printf '<!doctype html>\n' > internal/web/dist/index.html

test-backend: prepare-web-dist
	go test -race ./...

test-frontend:
	cd frontend && pnpm install --frozen-lockfile --silent && pnpm test

# 冒烟 e2e（桌面 + 移动两个 project）。scratch 轨道见 e2e/README.md。
test-e2e:
	cd e2e && pnpm install --frozen-lockfile --silent && pnpm exec playwright install --with-deps chromium && pnpm smoke

test-cover:
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

lint: lint-backend lint-frontend lint-e2e

lint-backend: prepare-web-dist
	golangci-lint run --timeout 10m

# eslint 已挂了 eslint-plugin-prettier，不用再单跑 prettier --check
lint-frontend:
	cd frontend && pnpm install --frozen-lockfile --silent && pnpm lint

# e2e 没有 eslint，只用 prettier 保证格式一致
lint-e2e:
	cd e2e && pnpm install --frozen-lockfile --silent && pnpm lint

# 一次性格式化两个前端包
fmt:
	cd frontend && pnpm format
	cd e2e && pnpm format

mock:
	go generate ./...
