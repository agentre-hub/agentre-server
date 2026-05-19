// Package code 集中维护 AgentRe Hub 的业务错误码与 i18n 提示。
//
// 段位：30000+ 给 hub（避开 agentre 桌面端 10000~20000 段）。
package code

// 通用 30000~30099
const (
	OperationFailed  = iota + 30000
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
)
