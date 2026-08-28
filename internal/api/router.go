package api

import (
	"context"
	"time"

	"github.com/cago-frame/cago/server/mux"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/controller/accountchan_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/agent_session_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/auth_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/device_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/engine_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/healthz_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/passkey_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/saved_session_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/sessionimport_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/stats_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/sync_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/workspace_ctr"
	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// RouterDeps 由 main.go 注入。
type RouterDeps struct {
	Cfg    *bootstrap.ServerConfig
	Signer *jwt.Signer
	Relay  relay_svc.RelaySvc
	// AccountChan 留给测试注入自己那份实时通道实现：两个副本要各带一份，
	// 而 accountchan_svc.Default() 一个进程只有一个。为空时取默认单例。
	AccountChan accountchan_svc.AccountChanSvc
}

// Router 构造完整路由树。
func (r *RouterDeps) Router(ctx context.Context, root *mux.Router) error {
	g := root.Group("/")

	healthzCtr := healthz_ctr.NewHealthz()
	authCtr := auth_ctr.NewAuth(r.Cfg.InsecureCookies)
	publicKeys := r.Cfg.JWT.PublicKeySet()
	deviceCtr := device_ctr.NewDeviceWithPublicKeys(publicKeys.CurrentKID, publicKeys.Keys,
		int64(r.Cfg.JWT.AccessTTL/time.Second))
	deviceCtr.SetSigner(r.Signer)
	relaySvc := r.Relay
	if relaySvc == nil {
		relaySvc = relay_svc.Default()
	}
	relayCtr := relay_ctr.New(relaySvc)
	accountChan := r.AccountChan
	if accountChan == nil {
		accountChan = accountchan_svc.Default()
	}
	accountChanCtr := accountchan_ctr.New(accountChan)
	syncCtr := sync_ctr.New()
	workspaceCtr := workspace_ctr.New()
	engineCtr := engine_ctr.New()
	savedSessionCtr := saved_session_ctr.New()
	agentSessionCtr := agent_session_ctr.New()
	passkeyCtr := passkey_ctr.New(r.Cfg.InsecureCookies)
	sessionImportCtr := sessionimport_ctr.New()
	statsCtr := stats_ctr.New()

	// 公开
	g.Group("/").Bind(
		healthzCtr.Healthz,
		deviceCtr.PublicKey,
	)

	// GitHub OAuth 端点（各自按 IP 限流）
	g.Group("/",
		middleware.GithubAuthorizePerIPLimit(r.Cfg.RateLimit.GithubAuthorizePerIPPerMin),
	).Bind(authCtr.GithubAuthorize)
	g.Group("/",
		middleware.GithubCallbackPerIPLimit(r.Cfg.RateLimit.GithubCallbackPerIPPerMin),
	).Bind(authCtr.GithubCallback)

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
		// 登录会话治理：只认浏览器会话——「哪一条是当前」这个判据来自 cookie，
		// 设备 JWT 那条路径上根本不存在。
		authCtr.ListSessions,
		authCtr.RevokeOtherSessions,
		deviceCtr.Pending,
		deviceCtr.Approve,
		deviceCtr.Deny,
		deviceCtr.RelayTicket,
		engineCtr.ListProviders,
		engineCtr.CreateProvider,
		engineCtr.UpdateProvider,
		engineCtr.DeleteProvider,
		engineCtr.ListBackends,
		engineCtr.CreateBackend,
		engineCtr.UpdateBackend,
		engineCtr.DeleteBackend,
		engineCtr.ListCLIOverlays,
		// 账号活跃统计：总览一条读、设置一读一写。三条都是 web 控制台自己的端点
		// ——桌面端不调它们（它那一侧是**上报**滚存，走的是设备 JWT 那条路），
		// 所以只认浏览器会话，不进 SessionOrDeviceAuth 那组。
		//
		// 读与写同挂一组没有问题：CSRF 中间件对 GET 直接放行（csrf.go 的 csrfOK），
		// 只有 PUT 那条要出示会话的 token——而它正是「凭 cookie 鉴权的写」。
		statsCtr.Overview,
		statsCtr.Settings,
		statsCtr.SaveSettings,
	)

	// 通行密钥：注册与管理一律要求浏览器会话 + CSRF。设备 JWT 那条路径上没有
	// 「当前是哪个浏览器」这个事实，而 challenge 正是按它归集的。
	passkeyGroup := g.Group("/", middleware.SessionAuth(), middleware.CSRF())
	// begin 单独再套两道限流：按 IP 挡匿名刷，按账号挡「换个出口接着刷」。
	// 两个中间件都排在 SessionAuth 之后——按账号那道要用它放进上下文的 user_id。
	passkeyGroup.Group("/",
		middleware.PasskeyRegisterBeginPerIPLimit(r.Cfg.RateLimit.PasskeyRegisterBeginPerIPPerMin),
		middleware.PasskeyRegisterBeginPerAccountLimit(r.Cfg.RateLimit.PasskeyRegisterBeginPerAccountPerMin),
	).Bind(passkeyCtr.BeginRegistration)
	passkeyGroup.Bind(
		passkeyCtr.FinishRegistration,
		passkeyCtr.List,
		passkeyCtr.Delete,
	)

	// 通行密钥登录：两个端点都公开——此刻还没有会话，请求里也没有任何标识
	// （决策 10）。begin 按 IP 限流，计数前缀与注册那道分开。
	g.Group("/",
		middleware.PasskeyLoginBeginPerIPLimit(r.Cfg.RateLimit.PasskeyLoginBeginPerIPPerMin),
	).Bind(passkeyCtr.BeginLogin)
	g.Group("/").Bind(passkeyCtr.FinishLogin)

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
		// 执行目标的派发顺序：把某个 Agent 的执行目标排成调用方要的次序，改的是
		// 账号默认顺序（决策 14）。本组鉴权的是用户，写入范围因此完全由 JWT / 会话
		// 里的账号圈定，请求体里没有任何身份字段。
		workspaceCtr.SetExecTargetOrder,
		// 组织面的读通道：索引与详情的全部材料（部门含空部门、Agent 的完整组织
		// 字段、每档执行目标含技能），以及配一档时能挑哪些后端。后端那条**只有
		// GET**——浏览器只能引用已有后端，见下面那段。
		workspaceCtr.OrgChart,
		workspaceCtr.SelectableBackends,
		// 组织面的写通道：浏览器建 / 改 / 删部门、Agent、执行目标，server 直写
		// sync_objects（规格 2026-08-18「server 端的组织管理面」）。与上面那条同理，
		// 账号只由本组的鉴权圈定，请求体里没有任何身份字段。
		//
		// **这里没有、也不会有 agent_backend 的建与改**：它是设备级对象，载荷里带
		// 本机可执行文件路径与透传环境变量，浏览器建出来的档必然不可用；web 上能做
		// 的是从已有后端里挑一个去配执行目标。
		workspaceCtr.CreateDepartment,
		workspaceCtr.UpdateDepartment,
		workspaceCtr.DeleteDepartment,
		workspaceCtr.CreateAgent,
		workspaceCtr.UpdateAgent,
		workspaceCtr.DeleteAgent,
		workspaceCtr.CreateExecTarget,
		workspaceCtr.UpdateExecTarget,
		workspaceCtr.DeleteExecTarget,
		// 项目一族的写通道（规格 2026-08-20「项目在 web 上成为一件可管理的事」）：
		// 浏览器建 / 改 / 删项目与项目成员，走的是上面那条同一条通道。加进来的理由
		// 与排除 agent_backend 的理由是同一条判据的两面——项目与成员关系的载荷全是
		// 「指向」，没有任何一件是机器上的东西。
		//
		// **路径不在这里**：项目在某台 agentred 上的绝对路径按「项目 × 指纹」逐条存在
		// project_location 上，另有自己的入口。
		workspaceCtr.CreateProject,
		workspaceCtr.UpdateProject,
		workspaceCtr.DeleteProject,
		workspaceCtr.CreateProjectMember,
		workspaceCtr.DeleteProjectMember,
		// 项目在各台机器上的落脚点：读一次给整节材料，写只认 agentred 的指纹
		// （桌面端的本机路径住在上报组，从 web 写不进去，决策 4）。读那一条是
		// R19 本轮唯一收窄的地方——只有它带得动路径，边界见 workspace 包守卫。
		workspaceCtr.ListProjectMachines,
		workspaceCtr.SetProjectLocation,
		workspaceCtr.DeleteProjectLocation,
		// web 统一会话索引的项目轴：账号的项目树。判定用的路径只在服务端参与比较，
		// 响应不带路径（R19，见 workspace 包守卫）。
		workspaceCtr.ListProjects,
		// 看板一族（规格 2026-08-27「看板：项目维度、筛选与呈现重构」）：读一条、
		// 写七条，走的是上面那条同一条通道。任务、标签与两者的关联**不新增任何表**，
		// 全部住在 sync_objects 里靠 kind 区分；六个筛选条件与项目子树计数在 Go 里算。
		// 加进来的理由与项目一族同一条：载荷全是「指向」——标题、描述、阶段、位置，
		// 以及项目 / Agent / 机器的同步标识，没有任何一件是机器上的东西。
		//
		// **这里同样没有 agent_backend 的建与改**：机器那颗 pill 只能从已有后端里挑
		// 一个（web 与桌面端唯一的功能差别），引用它的是任务载荷里的一个同步标识。
		workspaceCtr.Board,
		workspaceCtr.CreateIssue,
		workspaceCtr.UpdateIssue,
		workspaceCtr.MoveIssue,
		workspaceCtr.DeleteIssue,
		workspaceCtr.CreateIssueLabel,
		workspaceCtr.UpdateIssueLabel,
		workspaceCtr.DeleteIssueLabel,
		// 账号里保存的对话（决策 5：保存 / 删除取代关注 / 取消关注）：账号级，
		// 任一端（会话或设备 JWT）都可操作。保存把一条对话收进账号并开始镜像；
		// 删除清掉 server 那份，并让执行那条对话的机器也删掉它自己那一份。
		savedSessionCtr.Save,
		savedSessionCtr.Delete,
		// 名单读取（R14：任一端读到同一份）。GET /v1/follows 只回指向，本轮起
		// 统一会话索引改读下面这两个带内容的镜像端点（决策 9）。
		savedSessionCtr.List,
		// 账号里 agent 会话的两个只读端点（/v1/agent-sessions*）：索引读会话摘要
		// （项目归属就地判定，决策 12，浏览器不再上送 (机器指纹, cwd) 探针），
		// 详情页按游标翻转录。cwd 不出现在任一响应里（R19，见 workspace 包守卫）。
		agentSessionCtr.SavedSessions,
		agentSessionCtr.Transcript,
		// 侧栏「对话」那颗角标要的那一个数字。它单独成一条端点而不是让外壳去拉一页
		// 索引：这条路在每一次进入任何页面时都会跑一遍，而一页摘要里的标题、游标、
		// 项目归属一个都用不上。
		agentSessionCtr.WaitingCount,
		// 记下「读到这条对话为止」，供索引的「未读」那一档判定。它是写方法，
		// 本组的 session 分支已经强制 CSRF（session_or_device_auth.go）。
		agentSessionCtr.MarkSessionRead,
		// 导入本地会话（规格 2026-08-26）：问一台机器它磁盘上有哪些旧 CLI 会话、
		// 预览其中一条、让**那台机器**把它导进来。
		//
		// 三个端点都只认账号（本组鉴权的就是它）+ 一个设备 id：读别人机器上的磁盘
		// 转录必须在服务端拦住，而 device_id 归不归这个账号由 service 判。
		//
		// run 是写方法，与上面那条同理：本组的 session 分支已经强制 CSRF。它写的
		// 不是 server 的库——server 从不拥有会话，写在那台机器上，回来经镜像流上来。
		sessionImportCtr.Candidates,
		sessionImportCtr.Preview,
		sessionImportCtr.Run,
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
		engineCtr.Snapshot,
	)
	// websocket 不经过 mux 的 JSON 绑定，直接挂到 gin 路由。daemon 只接受真实
	// Device JWT；client 同时接受原生端 Device JWT 与浏览器短效 relay ticket。
	// 浏览器原生 WebSocket 无法设头，ticket 经 queryTokenBridge 从 query 搬入头部。
	deviceJWT.GET("/v1/relay/daemon", relayCtr.Daemon)
	tokenBridged := g.Group("/", queryTokenBridge(), middleware.RelayClientJWT(r.Signer))
	tokenBridged.GET("/v1/relay/client", relayCtr.Client)
	// 账号级实时通道：常连、不指定目标 daemon，服务端只往上面推「这个账号的同步
	// 版本推进到 V」。两端凭据形状与 client 那条完全一样，因此挂在同一组上。
	tokenBridged.GET("/v1/account/channel", accountChanCtr.Channel)

	return nil
}
