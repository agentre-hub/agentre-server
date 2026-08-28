// Package code 集中维护 AgentRe Server 的业务错误码与 i18n 提示。
//
// 段位：30000+ 给 server（避开 agentre 桌面端 10000~20000 段）。
package code

// 通用 30000~30099
const (
	OperationFailed = iota + 30000
	InvalidParameter
	NotFound
	ServerError
	Unauthorized
	Forbidden
)

// 账号 / OAuth 30100~30199
const (
	UserNotFound = iota + 30100
	UserBanned
	OAuthStateInvalid
	OAuthExchangeFailed
	OAuthProfileFailed
	GithubEmailMissing
	SessionExpired
	SessionInvalid
)

// Device Flow 30200~30299（与 RFC 8628 error 字段对齐）
const (
	DeviceFlowAuthorizationPending = iota + 30200
	DeviceFlowSlowDown
	DeviceFlowExpiredToken
	DeviceFlowAccessDenied
	DeviceFlowInvalidGrant
	DeviceFlowUserCodeInvalid
	DeviceFlowAlreadyConsumed
)

// Device / Token 30300~30399
const (
	DeviceNotFound = iota + 30300
	DeviceRevoked
	RefreshTokenReplay
	RefreshTokenExpired
	JWTSignatureInvalid
	JWTBlacklisted
	DeviceListFailed
	DeviceKindMismatch
)

// Relay 30400~30499
const (
	RelayDaemonNotFound = iota + 30400
	RelayDaemonOffline
	RelayForwardFailed
)

// 工作区多端同步 30500~30599
const (
	// SyncResyncRequired 设备距上次成功同步已超过墓碑保留窗口，上行一律被拒，
	// 必须先拉一份全量快照（R6a）。
	SyncResyncRequired = iota + 30500
	// SyncPayloadRejected 载荷带了不该过机的东西：桌面端的本地自增 ID，
	// 或凭据 / provider 行正文。
	SyncPayloadRejected
	// SyncKindInvalid 上行声明的对象类型不属于同步组，或与已有行的类型不符。
	SyncKindInvalid
	// SyncAvatarHashMismatch 头像正文的哈希与声明的不符。
	SyncAvatarHashMismatch
	// SyncAvatarNotFound 账号下没有这个哈希的头像。
	SyncAvatarNotFound
	// SyncCursorUnknown 设备送来的下行游标超出了本账号版本序列的头：这段历史
	// server 不认识（库被重建，或用户换了一套自建服务端）。
	//
	// 与 SyncResyncRequired 分成两个码，是因为客户端的处置**相反**：那一条是
	// 「你离线太久，server 的历史是全的、你的不全」，客户端只能以快照为准，
	// 队列里基版本对不上的一律拦下（R6a，防止把已回收的删除推回来）；这一条是
	// 「server 的历史没了、你的才是全的」，客户端必须把 server 不认识的本地行
	// 重新上行，否则整个工作区静默留在本机、界面上还显示一切正常。
	SyncCursorUnknown
)

// 通行密钥 30600~30699
//
// 新增码一律**追加到本段末尾**：这一段是 iota 递增的，往中间插一个常量会静默地把
// 后面每一个码的数值挪一位，前端照样编译，只是从此把一种失败认成另一种。
const (
	// PasskeyLimitReached 该账号的通行密钥数量已达上限，不再接受新的注册。
	PasskeyLimitReached = iota + 30600
	// PasskeyChallengeInvalid challenge 不存在、已过期、或不属于当前浏览器会话。
	// begin 与 finish 之间隔着用户在认证器上的操作，这是最常见的一种失败。
	PasskeyChallengeInvalid
	// PasskeyVerificationFailed 认证器的回应没通过校验：origin 不在允许列表、
	// challenge 对不上、attestation 不成立。
	PasskeyVerificationFailed
	// PasskeyAlreadyRegistered 这把认证器已经注册过。excludeCredentials 只是给浏览器
	// 的提示，真正的裁决在凭证 ID 的全局唯一索引上。
	PasskeyAlreadyRegistered
	// PasskeyNotFound 该账号名下没有这把通行密钥。
	PasskeyNotFound
	// PasskeyOriginNotAllowed 登录回应里的 origin 不在允许列表里。与
	// PasskeyVerificationFailed 分开，是因为它几乎总是部署配错（RP origin 没配上
	// 前端实际所在的那个端口），而不是用户做错了什么。
	PasskeyOriginNotAllowed
	// PasskeyCredentialUnknown 这把通行密钥不属于任何可用账号：库里认不出这个凭证
	// ID（密钥已被删、或者换了一套服务端）。
	PasskeyCredentialUnknown
	// PasskeyCounterRollback 签名计数器回退：库里存的与这次带上来的都非零，而这次
	// 没有前进——认证器可能被克隆了（决策 13）。
	PasskeyCounterRollback
)

// 账号级实时通道 30700~30799
const (
	// AccountChannelUnavailable 通道建不起来（订阅后端不可用）。客户端据此退回
	// 30 秒轮询即可：通道只送「该拉了」的信号，断着不丢数据，只是变慢。
	AccountChannelUnavailable = iota + 30700
)

// 组织面写通道 30800~30899
//
// 浏览器直写 sync_objects 的那条路径（规格 2026-08-18「server 端的组织管理面」）。
// 新增码一律**追加到本段末尾**，理由同通行密钥那一段。
const (
	// OrgKindNotWritable 这类对象不接受从 web 建 / 改 / 删。最要紧的一类是
	// agent_backend：它是设备级对象，载荷里带本机可执行文件路径与透传环境变量，
	// 浏览器无从知道那台机器上的可执行文件在哪，建出来的档必然不可用。web 上能
	// 做的是从已有后端里挑一个去配执行目标。
	OrgKindNotWritable = iota + 30800
	// OrgObjectNotFound 这个同步标识在**当前账号**下不存在，或它的类型与端点不符。
	// 两种情况共用一个码：区分开就等于给出一个跨账号的存在性探测器。
	OrgObjectNotFound
	// OrgObjectDeleted 目标已是墓碑。删除不复活（R6），界面据此提供「按这份内容
	// 新建」而不是让用户反复重试。
	OrgObjectDeleted
	// OrgBackendNotFound 执行目标引用的后端在当前账号下找不到（不存在、已落墓碑、
	// 或那个标识指向的根本不是后端）。执行目标只能引用已有后端。
	OrgBackendNotFound
	// OrgSystemAgentImmutable 系统 Agent（载荷里 system_badge 非空的那一个）不能删，
	// 也不能被写上归属。与桌面端 agent_svc 的 AgentSystemImmutable 是同一条判据：
	// 那边判在服务端，这边也必须判在服务端——禁用按钮拦不住直接打端点的请求，而
	// 落下去的墓碑会经下行游标到达每一台桌面端，在那里走的 adapter.remove 不过那道闸。
	OrgSystemAgentImmutable
	// OrgProjectParentCycle 父项目指向了这个项目自己或它的某个后代。同步下去会在
	// 每一端造出一个走不完的环：两端的项目树都按 parent 递归缩进，环意味着渲染
	// 永不终止。判在服务端而不是禁用下拉项——禁用拦不住直接打端点的请求。
	OrgProjectParentCycle
	// OrgProjectMemberExists 这个 Agent 已经是这个项目的成员了。再落一行成员关系
	// 会让成员清单里出现两个同一个人，删掉其中一个之后它还在——用户看到的是「删不掉」。
	OrgProjectMemberExists
	// OrgProjectPathDesktopReadOnly 桌面端的项目路径不走这条通道（规格 2026-08-21）。
	//
	// 它**不是**「web 配不了桌面端的路径」——那件事从 2026-08-21 起可以做，只是走
	// 中继：浏览器直接喊那台桌面端，由它自己写、自己重报。这条通道写的是账号级同步
	// 对象，而桌面端的本机路径只住在上报组、按上报设备分命名空间、整份快照替换，
	// 往那里写一行，下一次那台桌面端上报就把它冲掉了。判在服务端，因为禁用按钮拦不住
	// 直接打端点的请求。
	OrgProjectPathDesktopReadOnly
)

// 账号级引擎设置 30900~30999
const (
	// EngineProviderNotFound 当前账号下没有这个供应商（或它已删除）。
	EngineProviderNotFound = iota + 30900
	// EngineBackendNotFound 当前账号下没有这个后端身份（或它已删除）。
	EngineBackendNotFound
	// EngineCLIPathForbidden 浏览器不得提交设备本机的 CLI 绝对路径。
	EngineCLIPathForbidden
	// EngineBuiltinForbidden builtin 只有本机桌面端可创建，浏览器没有执行落点。
	EngineBuiltinForbidden
	// EngineBackendDeviceNotFound 写入的运行设备指纹在当前账号下不是一台活跃设备
	// ——查不到，或已撤销/未激活。与「没填设备」的 InvalidParameter 分开：编辑期间
	// 设备被撤销时，浏览器要能把它和「请选一台设备」区分开分别提示。
	EngineBackendDeviceNotFound
)

// 导入本地会话 31000~31099
//
// 新增码一律**追加到本段末尾**，理由同通行密钥那一段。
const (
	// SessionImportMachineOffline 握着那份转录的机器现在联系不上。它与下面那条
	// 必须分开：这一条只要把机器开起来，那一条要升级那台 agentred。
	SessionImportMachineOffline = iota + 31000
	// SessionImportFailed 这一次没导成（转录打不开、号被占着、回放中途失败）。
	// 那台机器给的原因随日志留下，浏览器据此让用户重试或换一条。
	SessionImportFailed
)
