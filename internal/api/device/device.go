package device

import "github.com/cago-frame/cago/server/mux"

// ---------- Public Key ----------

type PublicKeyRequest struct {
	mux.Meta `path:"/v1/keys" method:"GET"`
}

type PublicKeyResponse struct {
	Version                 int               `json:"version"`
	CurrentKID              string            `json:"current_kid"`
	Keys                    map[string]string `json:"keys"`
	PublicKey               string            `json:"public_key"`
	MaxTokenLifetimeSeconds int64             `json:"max_token_lifetime_seconds"`
}

// ---------- Device Flow ----------

type DeviceAuthorizeRequest struct {
	mux.Meta    `path:"/v1/oauth/device/authorize" method:"POST"`
	DeviceKind  string `json:"device_kind"  binding:"required,oneof=desktop agentred web mobile"`
	Fingerprint string `json:"fingerprint"  binding:"required,min=8,max=128"`
	Platform    string `json:"platform"     binding:"max=64"`
	Version     string `json:"version"      binding:"max=32"`
}
type DeviceAuthorizeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresIn               int    `json:"expires_in"`
}

type DeviceTokenRequest struct {
	mux.Meta   `path:"/v1/oauth/device/token" method:"POST"`
	GrantType  string `json:"grant_type"  binding:"required,eq=urn:ietf:params:oauth:grant-type:device_code"`
	DeviceCode string `json:"device_code" binding:"required"`
}
type DeviceTokenResponse struct {
	AccessToken      string `json:"access_token"`
	TokenType        string `json:"token_type"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshToken     string `json:"refresh_token"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
	DeviceID         int64  `json:"device_id"`
}

type DevicePendingRequest struct {
	mux.Meta `path:"/v1/oauth/device/pending" method:"GET"`
	UserCode string `form:"user_code" binding:"required"`
}
type DevicePendingResponse struct {
	DeviceKind string `json:"device_kind"`
	Platform   string `json:"platform"`
	Version    string `json:"version"`
	ExpiresIn  int    `json:"expires_in"`
}

type DeviceApproveRequest struct {
	mux.Meta `path:"/v1/oauth/device/approve" method:"POST"`
	UserCode string `json:"user_code" binding:"required"`
}
type DeviceApproveResponse struct {
	DeviceKind string `json:"device_kind"`
}

type DeviceDenyRequest struct {
	mux.Meta `path:"/v1/oauth/device/deny" method:"POST"`
	UserCode string `json:"user_code" binding:"required"`
}
type DeviceDenyResponse struct{}

// ---------- Web 设备注册 ----------

// DeviceRegisterRequest 是已登录浏览器按自己持久化的指纹换取 kind=web 设备身份的
// 端点（R1 / 决策 6）。走 SessionAuth+CSRF 组：未登录请求被中间件拒绝，到不了这里、
// 也不产生任何设备行。
type DeviceRegisterRequest struct {
	mux.Meta `path:"/v1/oauth/device/register" method:"POST"`
	// Fingerprint 是浏览器本地生成并持久化的设备指纹；同一个指纹重复注册按
	// (user_id, fingerprint) 幂等，不新增设备行。
	Fingerprint string `json:"fingerprint" binding:"required,min=8,max=128"`
	// Platform 是浏览器所在操作系统，进设备列表的展示列。
	Platform string `json:"platform" binding:"max=64"`
	// Version 是浏览器版本（展示用）。
	Version string `json:"version" binding:"max=32"`
	// Name 是浏览器声明的设备显示名（如「Chrome · macOS」）；缺省时服务端回退到
	// 指纹前 8 位。
	Name string `json:"name" binding:"max=128"`
}

type DeviceRegisterResponse struct {
	AccessToken      string `json:"access_token"`
	TokenType        string `json:"token_type"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshToken     string `json:"refresh_token"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
	DeviceID         int64  `json:"device_id"`
	JTI              string `json:"jti"`
}

// ---------- Token Refresh / Revoke ----------

type TokenRefreshRequest struct {
	mux.Meta     `path:"/v1/oauth/token/refresh" method:"POST"`
	RefreshToken string `json:"refresh_token" binding:"required"`
}
type TokenRefreshResponse struct {
	AccessToken      string `json:"access_token"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshToken     string `json:"refresh_token"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
}

type TokenRevokeRequest struct {
	mux.Meta `path:"/v1/oauth/token/revoke" method:"POST"`
	DeviceID int64 `json:"device_id"`
}
type TokenRevokeResponse struct{}

// ---------- Devices List ----------

type ListDevicesRequest struct {
	mux.Meta `path:"/v1/devices" method:"GET"`
}

type ListDevicesItem struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Platform     string `json:"platform"`
	Version      string `json:"version"`
	Fingerprint  string `json:"fingerprint"`
	LastSeenAt   int64  `json:"last_seen_at"`
	Status       int    `json:"status"`
	Online       bool   `json:"online"`
	IsThisDevice bool   `json:"is_this_device"`
}

type ListDevicesResponse struct {
	Devices []ListDevicesItem `json:"devices"`
}

// ---------- Revocations ----------

// RevocationsRequest 是 daemon 定期拉取吊销列表用的端点（R4 producer）。
// 只接受 device JWT；调用方的账号取自 JWT 里的 uid，不接受任意 URL 参数。
type RevocationsRequest struct {
	mux.Meta `path:"/v1/devices/revocations" method:"GET"`
}

type RevocationsResponse struct {
	// RevokedJTI 是调用方设备所属账号下，已吊销且仍在 AccessTTL 窗口内
	// （即仍可能验签通过）的 access token jti 全集。
	RevokedJTI []string `json:"revoked_jti"`
	// AsOf 是本次响应生成时刻（unix ms），供调用方判断新鲜度。
	AsOf int64 `json:"as_of"`
}
