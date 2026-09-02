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

FROM ${RUNTIME_IMAGE}
WORKDIR /app
COPY --from=go /out/server /app/server
COPY configs/config.example.yaml /app/configs/config.yaml
EXPOSE 8443
USER 65532:65532
ENTRYPOINT ["/app/server"]
