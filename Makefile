.PHONY: dev build test test-cover lint mock migrate docker

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

docker:
	docker build -t agentre/server:0.1 .

test:
	go test -race ./...

test-cover:
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

lint:
	golangci-lint run --timeout 10m

mock:
	go generate ./...
