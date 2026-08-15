package device_svc

import (
	"time"

	"agentre-server/internal/pkg/jwt"
)

// Config 装载从 cfg.Scan("server", ...) 得到的运行时参数。
type Config struct {
	UserCodeTTL     time.Duration
	PollInterval    time.Duration
	AccessTTL       time.Duration
	RefreshTTL      time.Duration
	VerificationURI string // e.g. "https://server.agentre.dev/device"
}

type AuthorizeInput struct {
	DeviceKind  string
	Fingerprint string
	Platform    string
	Version     string
	// Name 是客户端自报的显示名（通常是主机名），可空 —— 缺省时设备名回退到指纹缩写。
	Name string
}

type AuthorizeOutput struct {
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	Interval                int
	ExpiresIn               int
}

type TokenOutput struct {
	AccessToken      string
	RefreshToken     string
	ExpiresIn        int
	RefreshExpiresIn int
	DeviceID         int64
	JTI              string
}

type PendingInfo struct {
	DeviceKind string
	Platform   string
	Version    string
	ExpiresIn  int
}

// Signer 抽出 jwt.Signer 的最小接口，方便 mock。
type Signer interface {
	Sign(c jwt.Claims, ttl time.Duration) (string, string, error)
	Verify(token string) (*jwt.Claims, error)
}
