package api

import (
	"context"

	"github.com/cago-frame/cago/server/mux"

	"agentre-hub/internal/bootstrap"
	"agentre-hub/internal/controller/auth_ctr"
	"agentre-hub/internal/controller/device_ctr"
	"agentre-hub/internal/controller/healthz_ctr"
	"agentre-hub/internal/middleware"
	"agentre-hub/internal/pkg/jwt"
)

// RouterDeps 由 main.go 注入。
type RouterDeps struct {
	Cfg    *bootstrap.HubConfig
	Signer *jwt.Signer
}

// Router 构造完整路由树。
func (r *RouterDeps) Router(ctx context.Context, root *mux.Router) error {
	g := root.Group("/")

	healthzCtr := healthz_ctr.NewHealthz()
	authCtr := auth_ctr.NewAuth()
	deviceCtr := device_ctr.NewDevice()

	// 公开
	g.Group("/").Bind(
		healthzCtr.Healthz,
		authCtr.GithubAuthorize,
		authCtr.GithubCallback,
	)

	// device flow 端点（带 RFC 8628 错误注入 + 速率限制）
	oauthEndpoints := g.Group("/", middleware.AttachOAuthErrorFields())
	oauthEndpoints.Group("/",
		middleware.AuthorizePerIPLimit(r.Cfg.RateLimit.AuthorizePerIPPerMin),
	).Bind(deviceCtr.Authorize)
	oauthEndpoints.Group("/").Bind(
		deviceCtr.Token,
		deviceCtr.Refresh,
	)

	// 浏览器 session
	g.Group("/", middleware.SessionAuth(), middleware.CSRF()).Bind(
		authCtr.Logout,
		authCtr.Me,
		deviceCtr.Pending,
		deviceCtr.Approve,
		deviceCtr.Deny,
	)

	// device JWT
	g.Group("/", middleware.DeviceJWT(r.Signer)).Bind(
		deviceCtr.Revoke,
	)

	return nil
}
