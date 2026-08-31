package device

import "github.com/cago-frame/cago/server/mux"

type PublicKeyRequest struct {
	mux.Meta `path:"/v1/keys" method:"GET"`
}

type PublicKeyResponse struct {
	Version                 int               `json:"version"`
	CurrentKID              string            `json:"current_kid"`
	Keys                    map[string]string `json:"keys"`
	MaxTokenLifetimeSeconds int64             `json:"max_token_lifetime_seconds"`
}

type DeviceAuthorizeRequest struct {
	mux.Meta    `path:"/v1/oauth/device/authorize" method:"POST"`
	DeviceKind  string `json:"device_kind"  binding:"required,oneof=desktop agentred mobile"`
	Fingerprint string `json:"fingerprint"  binding:"required,min=8,max=128"`
	Platform    string `json:"platform"     binding:"max=64"`
	Version     string `json:"version"`
	// Name 是设备自报的显示名（通常是主机名）。可空 —— 不带它的老客户端照常授权，
	// 设备名回退到指纹缩写。设备流没有第二条途径拿到这个名字：不在这里带上，
	// 设备列表里每台机器就都只能叫指纹缩写。
	Name string `json:"name" binding:"max=128"`
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

// RelayTicketRequest 让已登录网页换取一枚只可用于 relay client 的短效票据。
// 它不创建 devices 行，也不能访问 daemon、同步或其它设备 JWT 端点。
type RelayTicketRequest struct {
	mux.Meta `path:"/v1/relay/ticket" method:"POST"`
}

type RelayTicketResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	// ClientID 是这枚票里签着的网页对端身份（账号级派生，决策 8/9）。浏览器拿它当
	// 自己的对端标识，而不是自己生成一个存在 localStorage 里——那个清一次站点数据
	// 就换人，此前从网页发起的对话在镜像里当场成为孤儿。
	ClientID string `json:"client_id"`
}

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
