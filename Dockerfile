# 三个基础镜像都是 ARG，默认值指向上游，所以本地 `make docker` / `docker compose build`
# 不传参也能跑；受限网络下由发布流水线覆盖成内网镜像地址。
# 注意 distroless 与 node/golang 不同源，没法共用一个前缀，所以是三个独立 ARG。
ARG NODE_IMAGE=node:22-alpine
ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12

# stage 1: frontend
FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
# corepack 自己下载 pnpm 时走的是 COREPACK_NPM_REGISTRY，与 pnpm 装包用的
# npm_config_registry 是两个变量，受限网络下缺一个都会卡住。
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    npm_config_registry=${NPM_REGISTRY} \
    CI=true
WORKDIR /src
RUN corepack enable
COPY frontend ./frontend
RUN cd frontend && pnpm install --frozen-lockfile && pnpm build

# stage 2: go
FROM ${GO_IMAGE} AS go
ARG GOPROXY=https://proxy.golang.org,direct
ARG VERSION=dev
ARG COMMIT=unknown
ENV GOPROXY=${GOPROXY}
WORKDIR /src
# 先只拷依赖清单，让 go mod download 单独成层——改业务代码时这层还能命中缓存
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# 前端产物必须在 go build 之前就位：internal/web/embed.go 用 //go:embed 嵌 dist，
# 目录不存在时是编译期失败，不是运行期才发现。
COPY --from=web /src/frontend/dist ./internal/web/dist
RUN CGO_ENABLED=0 go build -ldflags "-s -w \
      -X agentre-server/internal/buildinfo.Version=${VERSION} \
      -X agentre-server/internal/buildinfo.Commit=${COMMIT}" \
      -o /out/server ./cmd/server

# stage 3: runtime
FROM ${RUNTIME_IMAGE}
# WORKDIR 必须是 /app：cago 读的是相对路径 ./configs/config.yaml（configs/config.go
# 的默认 Option），所以工作目录决定了配置文件的位置。之前这里是 / 而配置被放到
# /etc/agentre-server/config.yaml，容器启动即 "load config: no such file or directory"。
WORKDIR /app
COPY --from=go /out/server /app/server
# 占位配置，实际部署时由 ConfigMap 以 subPath 覆盖同一路径
COPY configs/config.example.yaml /app/configs/config.yaml
EXPOSE 8443
USER nonroot:nonroot
ENTRYPOINT ["/app/server"]
