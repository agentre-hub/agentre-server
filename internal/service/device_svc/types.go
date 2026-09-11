package device_svc

import (
	"time"
)

// Config 装载从 cfg.Scan("server", ...) 得到的运行时参数。
type Config struct {
	FlowTTL         time.Duration
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
}

type PendingInfo struct {
	DeviceKind string
	Platform   string
	Version    string
	ExpiresIn  int
}
