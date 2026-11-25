// Package personaltoken 是个人 token 管理端点的传输契约（规格 2026-11-25-agrctl-account-peer
// 「个人 token 与范围」）。
//
// 四个管理端点都只认人（另有只认个人 token 的 self）：浏览器会话或 `cli` 设备的 access token。个人 token 自己调用一律 403。
// 时间都是 unix 毫秒。
package personaltoken

import "github.com/cago-frame/cago/server/mux"

// Token 是一枚个人 token 可以展示的全部事实，不含密钥。
type Token struct {
	Name string `json:"name"`
	// Scopes 是 read / chat / approve / resources:write / devices:write 的子集，固定次序。
	Scopes    []string `json:"scopes"`
	CreatedAt int64    `json:"created_at"`
	// ExpiresAt 为 0 表示永不过期。
	ExpiresAt int64 `json:"expires_at"`
	// LastUsedAt 为 0 表示从没用过；精度一分钟。
	LastUsedAt int64 `json:"last_used_at"`
	// RotatedAt 为 0 表示从没轮换过。
	RotatedAt int64 `json:"rotated_at"`
	// CreatedByDeviceID 是创建它的设备，浏览器会话创建的为 0；CreatedByDeviceName 是那台
	// 设备此刻的显示名，设备已撤销时为空串。
	CreatedByDeviceID   int64  `json:"created_by_device_id"`
	CreatedByDeviceName string `json:"created_by_device_name"`
}

// CreateRequest 创建一枚个人 token。名字在账号内唯一（大小写不敏感），已被占用答 409。
//
// 期限：两格都不给 = 30 天；ExpiresIn > 0 = 从现在起这么多秒；NoExpiry = 永不过期。
// 两格同时给答 400。
type CreateRequest struct {
	mux.Meta  `path:"/v1/personal-tokens" method:"POST"`
	Name      string   `json:"name" binding:"required"`
	Scopes    []string `json:"scopes" binding:"required"`
	ExpiresIn int64    `json:"expires_in"`
	NoExpiry  bool     `json:"no_expiry"`
}

// IssueResponse 是创建与轮换的答复。Token 是密钥明文，**只在这一次**出现，server 不保存它。
type IssueResponse struct {
	Token string `json:"token"`
	Item  Token  `json:"item"`
}

type ListRequest struct {
	mux.Meta `path:"/v1/personal-tokens" method:"GET"`
}

type ListResponse struct {
	Tokens []Token `json:"tokens"`
}

// SelfRequest 让一枚个人 token 查询自己：名字、范围、到期时间。只认个人 token（其它调用方
// 403，它们用 ListRequest）；个人 token 没有别的办法知道自己是哪一枚。
type SelfRequest struct {
	mux.Meta `path:"/v1/personal-tokens/self" method:"GET"`
}

type SelfResponse struct {
	Item Token `json:"item"`
	// PeerFingerprint 是这枚 token 的对端指纹：它发起的会话在账号会话索引与 agentred 上都记在
	// 这个发起方名下（agrctl list sessions --mine 据此认出自己的会话）。它是标识，不是凭据。
	PeerFingerprint string `json:"peer_fingerprint"`
}

// RotateRequest 给同名 token 换一个新密钥：名字、范围、对端指纹不变，旧密钥立即作废。
// 期限两格都不给时沿用原规则（原来 30 天就从现在起再算 30 天，原来永不过期仍永不过期）。
type RotateRequest struct {
	mux.Meta  `path:"/v1/personal-tokens/:name/rotate" method:"POST"`
	Name      string `uri:"name" binding:"required"`
	ExpiresIn int64  `json:"expires_in"`
	NoExpiry  bool   `json:"no_expiry"`
}

// DeleteRequest 吊销同名 token，HTTP 上立即生效。不存在答 404。
type DeleteRequest struct {
	mux.Meta `path:"/v1/personal-tokens/:name" method:"DELETE"`
	Name     string `uri:"name" binding:"required"`
}

type DeleteResponse struct{}
