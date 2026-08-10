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
)
