ARG NODE_IMAGE=node:22-alpine
ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12

FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    npm_config_registry=${NPM_REGISTRY} \
    CI=true
WORKDIR /src
RUN corepack enable
COPY frontend ./frontend
RUN cd frontend && pnpm install --frozen-lockfile && pnpm build

FROM ${GO_IMAGE} AS go
ARG GOPROXY=https://proxy.golang.org,direct
ARG VERSION=dev
ARG COMMIT=unknown
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/frontend/dist ./internal/web/dist
RUN CGO_ENABLED=0 go build -ldflags "-s -w \
      -X github.com/agentre-hub/agentre-server/internal/buildinfo.Version=${VERSION} \
      -X github.com/agentre-hub/agentre-server/internal/buildinfo.Commit=${COMMIT}" \
      -o /out/server ./cmd/server
# 运行段是 distroless,没 shell 也就建不了目录。空的具名卷会沿用镜像里 /keys 的
# 属主,少了这一步卷是 root:root,以 65532 跑的进程写不进自动生成的密钥。
RUN mkdir -p /out/keys

FROM ${RUNTIME_IMAGE}
WORKDIR /app
COPY --from=go /out/server /app/server
COPY --from=go --chown=65532:65532 /out/keys /keys
# 默认配置直接用 compose 那份,它本来就是照容器写的。compose 仍把同一个文件挂到
# 同一位置(改配置不用重打镜像),helm 用自己的 configmap,只有 docker run 吃这份。
COPY deploy/config.docker.yaml /app/configs/config.yaml
EXPOSE 8443
USER 65532:65532
ENTRYPOINT ["/app/server"]
