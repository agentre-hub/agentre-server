# 构建上下文是仓库根目录：docker build -f deploy/Dockerfile .
# 基础镜像与源都是 ARG，默认上游地址，受限网络下由流水线覆盖。

ARG NODE_IMAGE=node:22-alpine
ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12

# stage 1: frontend
FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
# corepack 下载 pnpm 自身用 COREPACK_NPM_REGISTRY，pnpm 装包用 npm_config_registry，两个都要
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
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# 必须在 go build 之前：internal/web 用 //go:embed 嵌 dist，缺了是编译期失败
COPY --from=web /src/frontend/dist ./internal/web/dist
RUN CGO_ENABLED=0 go build -ldflags "-s -w \
      -X agentre-server/internal/buildinfo.Version=${VERSION} \
      -X agentre-server/internal/buildinfo.Commit=${COMMIT}" \
      -o /out/server ./cmd/server

# stage 3: runtime
FROM ${RUNTIME_IMAGE}
# WORKDIR 决定配置文件位置：cago 读的是相对路径 ./configs/config.yaml
WORKDIR /app
COPY --from=go /out/server /app/server
# 占位配置，部署时由 ConfigMap 覆盖同一路径
COPY configs/config.example.yaml /app/configs/config.yaml
EXPOSE 8443
# 数字 uid 而非 nonroot：k8s 的 runAsNonRoot 无法校验非数字用户名，会拒绝启动
USER 65532:65532
ENTRYPOINT ["/app/server"]
