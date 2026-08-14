package api

import (
	"context"
	"time"

	"github.com/cago-frame/cago/server/mux"

	"agentre-server/internal/bootstrap"
	"agentre-server/internal/controller/auth_ctr"
	"agentre-server/internal/controller/device_ctr"
	"agentre-server/internal/controller/follow_ctr"
	"agentre-server/internal/controller/healthz_ctr"
	"agentre-server/internal/controller/relay_ctr"
	"agentre-server/internal/controller/sync_ctr"
	"agentre-server/internal/controller/workspace_ctr"
	"agentre-server/internal/middleware"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/service/relay_svc"
)

// RouterDeps 由 main.go 注入。
type RouterDeps struct {
	Cfg    *bootstrap.ServerConfig
	Signer *jwt.Signer
	Relay  relay_svc.RelaySvc
}

// Router 构造完整路由树。
func (r *RouterDeps) Router(ctx context.Context, root *mux.Router) error {
	g := root.Group("/")

	healthzCtr := healthz_ctr.NewHealthz()
	authCtr := auth_ctr.NewAuth(r.Cfg.InsecureCookies)
	publicKeys := r.Cfg.JWT.PublicKeySet()
	deviceCtr := device_ctr.NewDeviceWithPublicKeys(publicKeys.CurrentKID, publicKeys.Keys,
		int64(r.Cfg.JWT.AccessTTL/time.Second))
	relaySvc := r.Relay
	if relaySvc == nil {
		relaySvc = relay_svc.Default()
	}
	relayCtr := relay_ctr.New(relaySvc)
	syncCtr := sync_ctr.New()
	workspaceCtr := workspace_ctr.New()
	followCtr := follow_ctr.New()

	// 公开
	g.Group("/").Bind(
		healthzCtr.Healthz,
		authCtr.GithubAuthorize,
		authCtr.GithubCallback,
		deviceCtr.PublicKey,
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
		deviceCtr.Pending,
		deviceCtr.Approve,
		deviceCtr.Deny,
		// R1：已登录浏览器按持久化指纹换取 kind=web 设备身份。
		deviceCtr.RegisterWeb,
	)

	// session 或 device JWT 都可以
	g.Group("/", middleware.SessionOrDeviceAuth(r.Signer)).Bind(
		authCtr.Me,
		deviceCtr.Revoke,
		deviceCtr.List,
		// web 控制台两屏的只读端点（决策 13）：账号级 Agent 清单、设备展开详情。
		workspaceCtr.ListAgents,
		workspaceCtr.DeviceDetail,
		// R15：从 web 给「某 Agent + 某项目」取派发计划（哪台 agentred、逐档原因）。
		workspaceCtr.DispatchTarget,
		// 每端自己的派发顺序：保存调用方这台设备对某个 Agent 的执行目标排列。
		// 本组鉴权的是用户不是设备，设备指纹只能由参数传入，因此 service 必须先按
		// (user_id, fingerprint) 解析出设备行，解析不到即拒绝（决策 9）。
		workspaceCtr.SetExecTargetOrder,
		// 关注名单（R12 后端 + R14）：账号级，任一端（会话或设备 JWT）都可操作。
		followCtr.Follow,
		followCtr.Unfollow,
		followCtr.List,
	)

	// device JWT
	deviceJWT := g.Group("/", middleware.DeviceJWT(r.Signer))
	deviceJWT.Bind(deviceCtr.Revocations)
	// 工作区多端同步：账号与设备一律取自 JWT claims，不接受参数里的身份。
	deviceJWT.Bind(
		syncCtr.Push,
		syncCtr.Pull,
		syncCtr.ReportLocalPaths,
		syncCtr.PutAvatar,
		syncCtr.GetAvatar,
	)
	// websocket 不经过 mux 的 JSON 绑定，直接挂到 gin 路由；鉴权仍复用 device JWT。
	// client 额外接受 query 里的 access_token（浏览器原生 WebSocket 无法设头，见
	// queryTokenBridge）；daemon 是 Go 客户端、能设头，不需要这条桥。
	deviceJWT.GET("/v1/relay/daemon", relayCtr.Daemon)
	g.Group("/", queryTokenBridge(), middleware.DeviceJWT(r.Signer)).
		GET("/v1/relay/client", relayCtr.Client)

	return nil
}
