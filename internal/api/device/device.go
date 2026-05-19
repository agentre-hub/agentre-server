package device

import "github.com/cago-frame/cago/server/mux"

// ---------- Device Flow ----------

type DeviceAuthorizeRequest struct {
	mux.Meta     `path:"/v1/oauth/device/authorize" method:"POST"`
	DeviceKind   string          `json:"device_kind"  binding:"required,oneof=desktop agentred web mobile"`
	Fingerprint  string          `json:"fingerprint"  binding:"required,min=8,max=128"`
	Platform     string          `json:"platform"     binding:"max=64"`
	Version      string          `json:"version"      binding:"max=32"`
	Capabilities map[string]bool `json:"capabilities"`
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
	DeviceKind   string          `json:"device_kind"`
	Platform     string          `json:"platform"`
	Version      string          `json:"version"`
	Capabilities map[string]bool `json:"capabilities"`
	ExpiresIn    int             `json:"expires_in"`
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
