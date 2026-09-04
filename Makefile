.PHONY: dev build test test-backend test-frontend e2e test-cover \
        lint lint-backend lint-frontend lint-e2e fmt prepare-web-dist mock migrate docker

# 版本号是显式的、不从 tag 反推：git describe 在没打 tag 的分支上会退成 "dev"，
# 而带 tag 时又会多出一个 "v" 前缀，跟桌面端 Makefile 的 0.1.0 对不上号。排障
# 要的那一维由下面的 COMMIT 单独注入。
VERSION ?= 0.1.0
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

dev:
	@trap 'kill 0' INT; \
	  (cd frontend && pnpm install --silent && pnpm dev) & \
	  go run ./cmd/server & wait

build:
	cd frontend && pnpm install --frozen-lockfile && pnpm build
	# 先清空再拷：vite 的产物带内容哈希，文件名每次都不一样，只 cp 不删会让历史
	# chunk 全部留下、一起被 //go:embed 进二进制（本地实测 19M vs 3.1M）。镜像不受
	# 影响（.dockerignore 排除了这两个目录，Docker 从 web stage 干净拷贝），所以症状
	# 是「本地 build 的二进制比镜像里的大一截」，排障时容易误判。
	rm -rf internal/web/dist
	mkdir -p internal/web/dist
	cp -r frontend/dist/* internal/web/dist/
	CGO_ENABLED=0 go build -ldflags "-s -w \
	  -X github.com/agentre-hub/agentre-server/internal/buildinfo.Version=$(VERSION) \
	  -X github.com/agentre-hub/agentre-server/internal/buildinfo.Commit=$(COMMIT)" \
	  -o bin/server ./cmd/server

# 传版本号，否则镜像启动日志是 "dev (unknown)"，排障时对不回 commit
docker:
	docker build -f deploy/Dockerfile -t agentre/server:$(VERSION) \
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

# 唯一自动 E2E 入口：正式 server + 真实 MySQL/Redis + 桌面/移动 Chromium。
# configs/config.e2e.yaml 必须由本地专库配置或 CI setup 提供；runner 负责 build、
# migration、healthz、隔离 seed、浏览器、SQL oracle 与 cleanup。
e2e:
	cd e2e && pnpm install --frozen-lockfile --silent && pnpm exec playwright install-deps chromium && pnpm exec playwright install chromium && pnpm runner-test && pnpm smoke --project=desktop-chromium && pnpm smoke --project=mobile-chromium

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
