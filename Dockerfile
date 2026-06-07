# stage 1: frontend
FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY frontend ./frontend
RUN cd frontend && pnpm install --frozen-lockfile && pnpm build

# stage 2: go
FROM golang:1.26-alpine AS go
WORKDIR /src
COPY . .
COPY --from=web /src/frontend/dist ./internal/web/dist
RUN go mod download
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -o /server ./cmd/server

# stage 3: runtime
FROM gcr.io/distroless/static-debian12
COPY --from=go /server /server
COPY configs/config.example.yaml /etc/agentre-server/config.yaml
WORKDIR /
EXPOSE 8443
USER nonroot:nonroot
ENTRYPOINT ["/server"]
