// Package credentials 是「核验一枚别人出示给我的凭据」这个端点的传输契约（规格
// 2026-09-11-opaque-credentials-auto-direct，S5）。
//
// 调用方自己先要出示**它自己**的设备 access token 才能进这条路（DeviceJWT 那一组）；
// 请求体里再带一枚**另外**要问「它是谁」的令牌——设备 access token、中继票据、server
// 自用凭据都可能是它。典型调用方是 agentred 或桌面端：收到入站连接的对端出示了一枚
// 凭据，拿着自己的令牌来问 server 这枚凭据是不是同一账号下的东西。
package credentials

import "github.com/cago-frame/cago/server/mux"

// IntrospectRequest 提交一枚待核验的令牌。
//
// Token 留空、未知、过期、已撤销，或核验出的账号与调用方不同，答复都归到同一个
// CredentialInvalid：故意不写 binding:"required"——那会让「没带」在响应形状上与
// 「带了但无效」区分开，而这正是不该让持有者或调用方看出来的信息。
type IntrospectRequest struct {
	mux.Meta `path:"/v1/credentials/introspect" method:"POST"`
	Token    string `json:"token"`
}

// IntrospectResponse 是待核验令牌背后的身份，只有与调用方同一账号才答得出来。
type IntrospectResponse struct {
	// AccountID 是十进制账号 id 字符串，与 /v1/auth/me 的 user_id 是同一个值——
	// 字符串是因为这条契约面向另一个仓库的 Go 代码，那边把它当不透明标识比对，
	// 不该诱使谁拿它做数值运算。
	AccountID string `json:"account_id"`
	// DeviceID 只有设备 access token 非零；中继票据、server 自用凭据与个人 token 固定为 0。
	DeviceID int64 `json:"device_id"`
	// Kind 是设备 kind，或 relay_client / server_mirror / personal_token。
	Kind string `json:"kind"`
	// PeerFingerprint 是这枚令牌说了算的对端身份（决策 8）。个人 token 是它自己的对端指纹
	// （创建时生成、轮换不变），不是创建它的那台设备的。
	PeerFingerprint string `json:"peer_fingerprint"`
	// ExpiresIn 是这枚令牌的剩余有效期，整数秒。永不过期的个人 token 答 0（「没说剩多久」），
	// 接收方按自己的缓存时长复查。
	ExpiresIn int64 `json:"expires_in"`
	// Scopes 是个人 token 被授予的范围（read / chat / approve / resources:write /
	// devices:write）；其余凭据不带这一格，能力由 Kind 决定。
	Scopes []string `json:"scopes,omitempty"`
	// TokenName 是个人 token 在账号里的名字；其余凭据不带这一格。
	TokenName string `json:"token_name,omitempty"`
}
