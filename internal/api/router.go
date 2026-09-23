package api

import (
	"context"
	"fmt"
	"net/http"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux"
	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/controller/accountchan_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/agent_session_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/auth_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/credentials_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/ctl_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/device_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/engine_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/healthz_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/passkey_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/portforward_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/relay_ctr/relayws"
	"github.com/agentre-hub/agentre-server/internal/controller/release_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/saved_session_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/sessionimport_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/stats_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/sync_ctr"
	"github.com/agentre-hub/agentre-server/internal/controller/workspace_ctr"
	"github.com/agentre-hub/agentre-server/internal/middleware"
	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/ctl_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
)

// RouterDeps 由 main.go 注入。
type RouterDeps struct {
	Cfg   *bootstrap.ServerConfig
	Relay relay_svc.RelaySvc
	// AccountChan 留给测试注入自己那份实时通道实现：两个副本要各带一份，
	// 而 accountchan_svc.Default() 一个进程只有一个。为空时取默认单例。
	// 它没有自己的端点，账号信号走中继客户端连接的保留通道（决策 13）。
	AccountChan accountchan_svc.AccountChanSvc
	// MachineUpgrader 是控制台一键升级够到那台机器的实现。留给测试注入自己那份；
	// 为空时控制器落到本进程那份常驻镜像（mirror_svc.Default()）。
	MachineUpgrader device_ctr.MachineUpgrader
	// PortForward 是这个副本手里那份端口转发连接池。留给测试注入自己那份；为空时
	// 取 portforward_svc.Default()——它未装配时是 nil，意思是「这个部署没有端口
	// 转发」，路由层据此答「此刻没有这条能力」，而不是去拨一个不存在的中继。
	PortForward portforward_ctr.Forwarder
	// PortForwardLinks 是端口转发子域前缀的分配器（spec「地址与路由」的「分配
	// 前缀」）。留给测试注入自己那份；为空时取 portforward_svc.DefaultLinks()——
	// 与 PortForward 上面那份约定同形，只是这一份不会是 nil（没配 base_domain 的
	// 部署仍然装配它，只是 Link 恒回「此刻提供不了端口转发」）。
	PortForwardLinks portforward_ctr.LinkAllocator
	// PortForwardPrefixes 按前缀反查链接、拼转发地址（转发子域的 Host 分发与
	// authorize 用）。留给测试注入；为空时取 portforward_svc.DefaultLinks()。
	PortForwardPrefixes portforward_ctr.PrefixResolver
	// PortForwardAuth 是转发登录（一次性授权码与转发会话，spec「转发登录」）。留给
	// 测试注入；为空时取 portforward_svc.DefaultForwardAuth()。
	PortForwardAuth portforward_ctr.ForwardSessions
	// Redis 是鉴权中间件要用的那台：中继票据「只连一次」的认领记号从它派生。
	// 留给测试注入自己那台；为空时取全局默认单例（与上面两项同一约定）。
	Redis *goredis.Client
	// Bearer 是鉴权中间件解析设备 access token 的那一个解析方。留给测试注入自己那份；
	// 为空时取 device_svc.Default()（按摘要查 MySQL），与上面几项同一约定。
	Bearer middleware.BearerResolver
	// Ctl 是 agrctl 资源接口的执行者。留给测试注入；为空时每次请求取 ctl_svc.Default()。
	Ctl ctl_svc.CtlSvc

	// drainer 由 Router 在装配时填上：进程收到停止信号时,用它把这个副本手里的
	// 长连接逐条礼貌关掉(见 DrainRelays)。
	//
	// 控制器是在 Router 里现造的,main 拿不到它们;而 RouterDeps 本来就是 main
	// 持有的那个指针,把把手挂回它身上比给 Router 加一个返回值省事,也不必让
	// main 去认识 relay_ctr。
	drainer relayws.Drainer
}

// DrainRelays 优雅下线:把这个副本手里的中继 websocket 逐条礼貌关掉
// (1001 Going Away),交回一共关了几条。
//
// 为什么必须有这一步。这些是长连接,读循环阻塞在 ReadMessage 上永远不返回,于是:
//   - 什么都不做直接退出 → 对端读到 1006,与网线被拔分不开,只能按网络抖动退避;
//     而这一次它本该立刻重连、并落到另一个还活着的副本上;
//   - mux 的 Shutdown 会等 handler 返回 → 没有这一步,进程会一直卡在停止那一步,
//     直到宽限期结束被 SIGKILL,连接照样是硬断的。
//
// 幂等:排空过的连接已经从登记表里摘掉,重复调用交回 0。
func (r *RouterDeps) DrainRelays() int {
	if r.drainer == nil {
		return 0
	}
	return r.drainer.Drain()
}

// trustProxies 决定 c.ClientIP() 相信谁 —— 也就是所有按 IP 归集的限流
// （middleware.byIP：设备流 authorize、GitHub OAuth 的两端、通行密钥登录）和
// /account 里展示的登录 IP，按谁算。
//
// **必须显式配**：gin 的缺省是信任全部代理（trustedProxies = 0.0.0.0/0 + ::/0，
// ForwardedByClientIP 为真），于是来源 IP 取的是 X-Forwarded-For 最左边那一格 ——
// 一个请求方自己填的值。那样每一道按 IP 的配额都只要换个头就能重开一桶，而
// compose 那条部署路径上 8443 直接映射到宿主、前面没有反代，攻击者就是直连的那一端。
//
// 名单空 = 谁都不信，来源 IP 一律取实际连上来的那一端（ServerConfig.TrustedProxies
// 上写了为什么这个默认值只能由部署方改）。反过来，只要声明了一跳，XFF 才重新作数，
// 并且只对来自那一跳的请求作数。
//
// 名单写错时上交错误、让启动失败：安静退回缺省就等于「配了跟没配一样」，而运维会
// 以为限流已经按真实客户端 IP 归集了。
func trustProxies(root *mux.Router, trusted []string) error {
	// cago 把引擎藏在 gin.IRouter 后面，而「信谁」是引擎上的一格设置，不是一个中间件。
	engine, ok := root.IRouter.(*gin.Engine)
	if !ok {
		return fmt.Errorf("configure trusted proxies: router is %T, not *gin.Engine", root.IRouter)
	}
	engine.ForwardedByClientIP = len(trusted) > 0
	if err := engine.SetTrustedProxies(trusted); err != nil {
		return fmt.Errorf("configure trusted proxies: %w", err)
	}
	return nil
}

// Router 构造完整路由树。
func (r *RouterDeps) Router(ctx context.Context, root *mux.Router) error {
	if err := trustProxies(root, r.Cfg.TrustedProxies); err != nil {
		return err
	}
	// 转发子域的 Host 分发必须是整棵树上**第一个**装上的东西（spec「按 Host 分发」）：
	// gin 在注册路由时把当下的全局中间件拼进那条路由的处理链，Use 之后注册的每一条
	// 控制台路由、以及 SPA 兜底（NoRoute，Use 会重建它的处理链）都先经过它；转发
	// Host 上的请求在这里整条处理完并 Abort，轮不到 SessionAuth、CSRF 或 SPA。
	//
	// 结尾斜杠的 301 同理必须关掉：gin 在匹配路由时（早于任何中间件）就对「差一个结尾
	// 斜杠就能命中」的路径答 301，转发 Host 上应用自己的 /v1/auth/me/ 因此永远到不了
	// Host 分发，而 301 还会被浏览器永久缓存。控制台一侧没有依赖它的地方：未命中的
	// /v1/* 本来就答 404（internal/web），/fw 由下面显式的那条接住。
	//
	// cago 在回调之前注册的 /health 与 metric 组件的 /metrics 不在这条链上：那两条
	// 路由的处理链在本回调之前就定下了，转发 Host 上照样由它们作答（被转发应用自己的
	// 这两个路径因此到不了，与 /__agentre/ 同一类已知代价）。
	portForwardHost := r.portForwardHost()
	engine := root.IRouter.(*gin.Engine)
	engine.RedirectTrailingSlash = false
	engine.Use(portForwardHost.Dispatch)

	g := root.Group("/")
	// 写请求来源校验的名单（spec 2026-09-21「控制台加固」）：控制台自己的 origin 加已
	// 配置的 origins，CSRF 与 SessionOrDeviceAuth 的 cookie 分支共用这一份。
	consoleOrigins := r.Cfg.ConsoleOrigins()

	healthzCtr := healthz_ctr.NewHealthz()
	authCtr := auth_ctr.NewAuth(r.Cfg.InsecureCookies)
	deviceCtr := device_ctr.NewDevice()
	if r.MachineUpgrader != nil {
		deviceCtr.SetMachineUpgrader(r.MachineUpgrader)
	}
	relaySvc := r.Relay
	if relaySvc == nil {
		relaySvc = relay_svc.Default()
	}
	accountChan := r.AccountChan
	if accountChan == nil {
		accountChan = accountchan_svc.Default()
	}
	// 设备 access token 的解析方只在这里取一次，交给下面三个接受 Bearer 的中间件。
	// device_svc 未装配时 Default() 是 nil 接口，转成 BearerResolver 仍是 nil，中间件
	// 据此一律 401。
	bearer := r.Bearer
	if bearer == nil {
		bearer = device_svc.Default()
	}
	// 中继客户端入口认两种凭据：设备 access token 仍交给上面那个解析方，浏览器票据由
	// auth_svc 从短效凭据存储解析。票据「只连一次」的认领记号在这里造一份——这是本层唯一
	// 认识「Redis 是哪一台」的地方，中间件自己只认拿到的对象。
	redisClient := r.Redis
	if redisClient == nil {
		redisClient = redis.Default()
	}
	relayBearer := auth_svc.NewCredentialResolver(bearer, auth_svc.Default())
	relayTickets := credstore.New(redisClient)
	// 核验端点认得 server 签发的全部 Bearer 凭据——待核验的那一枚可能是设备 access
	// token、中继票据或 server 自用凭据，与 /v1/relay/client 用的是同一个解析方
	// （规格 2026-09-11-opaque-credentials-auto-direct，S5）。
	credentialsCtr := credentials_ctr.New(relayBearer)
	// 账号信号没有自己的端点了（决策 13）：它跑在中继客户端连接的保留通道上，
	// 因此在这里装配进 relay_ctr，而不是另挂一条路由。
	relayCtr := relay_ctr.New(relaySvc, accountchan_ctr.New(accountChan))
	r.drainer = relayCtr
	syncCtr := sync_ctr.New()
	workspaceCtr := workspace_ctr.New()
	engineCtr := engine_ctr.New()
	savedSessionCtr := saved_session_ctr.New()
	agentSessionCtr := agent_session_ctr.New()
	passkeyCtr := passkey_ctr.New(r.Cfg.InsecureCookies)
	sessionImportCtr := sessionimport_ctr.New()
	statsCtr := stats_ctr.New()
	releaseCtr := release_ctr.New()
	// 端口转发子域链接（spec 2026-09-21-port-forward-subdomain「地址与路由」）：
	// 归属判定复用 device_svc.Default()（与 portforward_ctr.New 那一份同一个
	// DeviceLookup 口径），分配器留给测试注入；为空时取本进程那份
	// （bootstrap.RegisterDefaults 总会装配它——没配 base_domain 的部署也装配，只是
	// Link 恒回「此刻提供不了端口转发」，所以这里不需要 PortForward 那种「未装配即
	// nil」的额外判空）。
	portForwardLinks := r.PortForwardLinks
	if portForwardLinks == nil {
		portForwardLinks = portforward_svc.DefaultLinks()
	}
	portForwardLinksCtr := portforward_ctr.NewLinks(device_svc.Default(), portForwardLinks)

	// 公开
	g.Group("/").Bind(
		healthzCtr.Healthz,
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
	g.Group("/", middleware.SessionAuth(), middleware.CSRF(consoleOrigins)).Bind(
		authCtr.Logout,
		// 登录会话治理：只认浏览器会话——「哪一条是当前」这个判据来自 cookie，
		// 设备 JWT 那条路径上根本不存在。
		authCtr.ListSessions,
		authCtr.RevokeOtherSessions,
		deviceCtr.Pending,
		deviceCtr.Approve,
		deviceCtr.Deny,
		deviceCtr.RelayTicket,
		// 一键升级会重启用户的机器：浏览器会话 + CSRF 那一组，与撤销设备同级。
		// 它只走 web 控制台这条路——桌面端有自己那条直连（remote_device_svc）。
		deviceCtr.Upgrade,
		engineCtr.ListProviders,
		engineCtr.CreateProvider,
		engineCtr.UpdateProvider,
		engineCtr.DeleteProvider,
		engineCtr.CreateProviderModel,
		engineCtr.UpdateProviderModel,
		engineCtr.DeleteProviderModel,
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
		// 控制台的 latest 来源（决策 12）：只读、账号无关的全局事实，但眼下只有
		// web 控制台会问它，与统计三条同组即可——不必新开一个鉴权面。
		releaseCtr.Latest,
		// 端口转发子域链接：对自己名下一台设备的一条映射 id 分配（或复用）一个转发
		// 前缀（spec「分配前缀」）。写方法，本组已经强制 CSRF——与撤销设备、改名
		// 同一形状。
		portForwardLinksCtr.Create,
	)

	// 通行密钥：注册与管理一律要求浏览器会话 + CSRF。设备 JWT 那条路径上没有
	// 「当前是哪个浏览器」这个事实，而 challenge 正是按它归集的。
	passkeyGroup := g.Group("/", middleware.SessionAuth(), middleware.CSRF(consoleOrigins))
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

	// session 或设备 access token 都可以
	g.Group("/", middleware.SessionOrDeviceAuth(bearer, consoleOrigins)).Bind(
		authCtr.Me,
		deviceCtr.Revoke,
		deviceCtr.List,
		// 账号级备注名：设备名是那台机器自报的主机名，同一台电脑上的几个 checkout
		// 在账号里就是几行同名设备。能读到这份清单的调用方就能给清单里的行起名字。
		deviceCtr.Rename,
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
		// 账号里 agent 会话的两个只读端点（/v1/agent-sessions*）：索引读会话摘要
		// （项目归属就地判定，决策 12），
		// 详情页按游标翻转录。cwd 不出现在任一响应里（R19，见 workspace 包守卫）。
		agentSessionCtr.SavedSessions,
		agentSessionCtr.Transcript,
		// 侧栏「对话」那颗角标要的那两个数字（等你处理 / 未读）。它单独成一条端点
		// 而不是让外壳去拉一页索引：这条路在每一次进入任何页面时都会跑一遍，而一页
		// 摘要里的标题、游标、项目归属一个都用不上。
		agentSessionCtr.AttentionCount,
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

	// 设备 access token
	deviceJWT := g.Group("/", middleware.DeviceJWT(bearer))
	// 工作区多端同步：账号与设备一律取自令牌解析出的身份，不接受参数里的身份。
	deviceJWT.Bind(
		syncCtr.Push,
		syncCtr.Pull,
		syncCtr.ReportLocalPaths,
		syncCtr.PutAvatar,
		syncCtr.GetAvatar,
		engineCtr.Snapshot,
	)
	// 核验一枚别人出示的凭据（S5）：调用方必须先出示自己的设备 access token
	// （DeviceJWT 那组已经做到），再按调用方账号限流——挂在 DeviceJWT 之后，
	// 这样限流键才能取到它放进上下文的账号。
	// agrctl 资源管理（规格 2026-09-22 agrctl-resource-management「server 执行者」）：
	// 控制台派发到 agentred 的会话里，agent 调 agrctl，agentred 在会话里审批后转过来。
	// **只认设备 access token**——浏览器会话进不来，所以不需要 CSRF；提供方与后端的写入
	// 因此能以设备身份执行，而浏览器那一组（SessionAuth + CSRF）原样不动。正文是
	// protojson、错误是 {"error": …}，与桌面端的 /ctl/v1/resources 同形，不走 mux 信封。
	ctlCtr := ctl_ctr.New(r.Ctl)
	deviceJWT.POST(ctl_ctr.ResourcesPath, ctlCtr.Resources)
	deviceJWT.POST(ctl_ctr.SendPath, ctlCtr.Send)
	deviceJWT.Group("/",
		middleware.CredentialsIntrospectPerAccountLimit(r.Cfg.RateLimit.CredentialsIntrospectPerAccountPerMin),
	).Bind(credentialsCtr.Introspect)
	// websocket 不经过 mux 的 JSON 绑定，直接挂到 gin 路由。daemon 只接受设备
	// access token；client 同时接受原生端设备 access token 与浏览器短效 relay ticket。
	// 浏览器原生 WebSocket 无法设头，ticket 经 relayTokenBridge 从子协议搬入头部。
	deviceJWT.GET("/v1/relay/daemon", relayCtr.Daemon)
	tokenBridged := g.Group("/", relayTokenBridge(), middleware.RelayClientJWT(relayBearer, relayTickets))
	// 这一条同时承载账号信号：普通通道跑 RPC，保留通道（relay_svc.SignalChannelID）
	// 推 sync_version / mirror_changed / device_presence。
	tokenBridged.GET("/v1/relay/client", relayCtr.Client)

	// /fw/…（规格 2026-09-09-console-port-forward-host 的旧地址：
	// /fw/<device_id>/<port>/<被转发应用自己的路径>）**直接删除，不留兼容期、不做
	// 重定向**（规格 2026-09-21-port-forward-subdomain 决策 13）：首发按全新发布处理，
	// 旧地址里带着设备号和端口，没有存量地址要兼容。
	//
	// 控制台主机上因此不再挂任何 /fw/ 路由。这里仍然显式注册一条通配、直接答 404 的
	// 处理器，而不是干脆什么都不挂：什么都不挂的话 /fw/… 会落到 internal/web 的 SPA
	// 兜底上，非 /v1/* 的未命中路径一律 200 + index.html（决策 10 那条「白屏而状态码
	// 正常」的缺陷源头），/fw/ 曾经是一整段 API 表面，不该悄悄变成一张 SPA 页。显式
	// 404 让它和其余未绑定的后端路径同一种答法。
	//
	// 转发本身改到 <前缀>.<base_domain> 这条子域上，由本函数开头装上的
	// portForwardHost.Dispatch 按 Host 整条接走。/fw 与 /fw/*rest 两条都挂：gin 的路由树
	// 里 /fw/*rest 不收裸的 /fw，而结尾斜杠的 301 已经关掉了。
	legacyPortForward := func(c *gin.Context) { c.AbortWithStatus(http.StatusNotFound) }
	g.Any("/fw", legacyPortForward)
	g.Any("/fw/*rest", legacyPortForward)

	// 转发登录第 2、3 步：控制台上签发一次性授权码。裸 gin 而不是 mux.Bind——它答的是
	// 浏览器顶层导航的 302，不是 JSON；没登录时要跳登录页而不是 401，所以鉴权在控制器
	// 里自己判（与 SessionAuth 同一套判据）。GET，不过 CSRF。
	g.GET(portforward_ctr.AuthorizePath, portForwardHost.Authorize)

	return nil
}

// portForwardHost 装配转发子域的控制器：注入的优先，其余取本进程默认那份。
//
// 三处 Default() 在未装配时是 nil 指针，**不能**无条件赋给接口：那样得到的是一个
// 非 nil 的接口装着 nil 指针，控制器里「没装配」的判据就永远不成立了。
func (r *RouterDeps) portForwardHost() *portforward_ctr.Host {
	var forwarder portforward_ctr.Forwarder
	switch {
	case r.PortForward != nil:
		forwarder = r.PortForward
	case portforward_svc.Default() != nil:
		forwarder = portforward_svc.Default()
	}
	var prefixes portforward_ctr.PrefixResolver
	switch {
	case r.PortForwardPrefixes != nil:
		prefixes = r.PortForwardPrefixes
	case portforward_svc.DefaultLinks() != nil:
		prefixes = portforward_svc.DefaultLinks()
	}
	var sessions portforward_ctr.ForwardSessions
	switch {
	case r.PortForwardAuth != nil:
		sessions = r.PortForwardAuth
	case portforward_svc.DefaultForwardAuth() != nil:
		sessions = portforward_svc.DefaultForwardAuth()
	}
	relaySvc := r.Relay
	if relaySvc == nil {
		relaySvc = relay_svc.Default()
	}
	return portforward_ctr.NewHost(
		portforward_ctr.New(device_svc.Default(), relaySvc, forwarder),
		prefixes, sessions,
		portforward_ctr.HostConfig{
			BaseDomain:      r.Cfg.PortForward.BaseDomain,
			PublicURL:       r.Cfg.PublicURL,
			InsecureCookies: r.Cfg.InsecureCookies,
		},
	)
}
