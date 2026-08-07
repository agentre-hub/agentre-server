// Package bootstrap 集中处理 agentre-server 的启动期组装：
//   - 从 env 注入敏感字段（cago 配置源不支持 env override）
//   - 加载 JWT 密钥
//   - 注册 GitHub OAuth client
//   - 初始化 auth_svc / device_svc 默认实例
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/database/redis"

	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/session"
	"agentre-server/internal/repository/device_repo"
	"agentre-server/internal/service/auth_svc"
	"agentre-server/internal/service/device_svc"
	"agentre-server/internal/service/oauth_svc"
	"agentre-server/internal/service/relay_svc"
)

type ServerConfig struct {
	PublicURL       string        `yaml:"public_url"`
	InsecureCookies bool          `yaml:"insecure_cookies"`
	Session         SessionConfig `yaml:"session"`
	DeviceFlow      DFConfig      `yaml:"device_flow"`
	JWT             JWTConfig     `yaml:"jwt"`
	OAuth           OAuthConfig   `yaml:"oauth"`
	RateLimit       RLConfig      `yaml:"rate_limit"`
}

type SessionConfig struct {
	CookieName string        `yaml:"cookie_name"`
	TTL        time.Duration `yaml:"ttl"`
	Secret     string        `yaml:"secret"`
}

type DFConfig struct {
	UserCodeTTL  time.Duration `yaml:"user_code_ttl"`
	PollInterval time.Duration `yaml:"poll_interval"`
}

type JWTConfig struct {
	PrivateKeyPEMPath string        `yaml:"private_key_pem_path"`
	PublicKeyPEMPath  string        `yaml:"public_key_pem_path"`
	PrivateKeyPEM     string        `yaml:"private_key_pem"`
	PublicKeyPEM      string        `yaml:"public_key_pem"`
	Issuer            string        `yaml:"issuer"`
	Audience          string        `yaml:"audience"`
	AccessTTL         time.Duration `yaml:"access_ttl"`
	RefreshTTL        time.Duration `yaml:"refresh_ttl"`
}

type OAuthConfig struct {
	Github GithubOAuthConfig `yaml:"github"`
}

type GithubOAuthConfig struct {
	ClientID     string `yaml:"client_id"`
	ClientSecret string `yaml:"client_secret"`
	CallbackPath string `yaml:"callback_path"`
}

type RLConfig struct {
	AuthorizePerIPPerMin int64 `yaml:"authorize_per_ip_per_min"`
}

// LoadServerConfig 从 cfg 取 server.* + env 覆盖，返回最终配置。
func LoadServerConfig(ctx context.Context, cfg *configs.Config) *ServerConfig {
	out := &ServerConfig{}
	if err := cfg.Scan(ctx, "server", out); err != nil {
		if legacyErr := cfg.Scan(ctx, "hub", out); legacyErr != nil {
			log.Fatalf("scan server config: %v", err)
		}
	}
	setIfPresent("AGENTRE_SERVER_PUBLIC_URL", &out.PublicURL)
	setIfPresent("AGENTRE_SERVER_OAUTH_GITHUB_CLIENT_ID", &out.OAuth.Github.ClientID)
	setIfPresent("AGENTRE_SERVER_OAUTH_GITHUB_CLIENT_SECRET", &out.OAuth.Github.ClientSecret)
	setIfPresent("AGENTRE_SERVER_SESSION_SECRET", &out.Session.Secret)
	setIfPresent("AGENTRE_SERVER_JWT_PRIVATE_KEY_PEM", &out.JWT.PrivateKeyPEM)
	setIfPresent("AGENTRE_SERVER_JWT_PUBLIC_KEY_PEM", &out.JWT.PublicKeyPEM)
	if v := os.Getenv("AGENTRE_SERVER_INSECURE_COOKIES"); v == "1" || strings.EqualFold(v, "true") {
		out.InsecureCookies = true
	}
	if out.Session.CookieName == "" {
		out.Session.CookieName = "server_session"
	}
	if out.Session.TTL == 0 {
		out.Session.TTL = 14 * 24 * time.Hour
	}
	if out.DeviceFlow.UserCodeTTL == 0 {
		out.DeviceFlow.UserCodeTTL = 10 * time.Minute
	}
	if out.DeviceFlow.PollInterval == 0 {
		out.DeviceFlow.PollInterval = 5 * time.Second
	}
	if out.JWT.AccessTTL == 0 {
		// R4：访问凭据必须是分钟级短有效期，靠刷新续期。
		out.JWT.AccessTTL = 15 * time.Minute
	}
	if out.JWT.RefreshTTL == 0 {
		out.JWT.RefreshTTL = 90 * 24 * time.Hour
	}
	if out.JWT.Issuer == "" {
		out.JWT.Issuer = "agentre-server"
	}
	if out.JWT.Audience == "" {
		out.JWT.Audience = "agentre"
	}
	if out.OAuth.Github.CallbackPath == "" {
		out.OAuth.Github.CallbackPath = "/v1/auth/oauth/github/callback"
	}
	if out.RateLimit.AuthorizePerIPPerMin == 0 {
		out.RateLimit.AuthorizePerIPPerMin = 3
	}
	return out
}

func setIfPresent(env string, dst *string) {
	if v := os.Getenv(env); v != "" {
		*dst = v
	}
}

// LoadJWTSigner 解析 cfg.JWT 中的 PEM 内容/路径并构造 Signer。
func LoadJWTSigner(cfg *ServerConfig) *jwt.Signer {
	priv := loadPEM(cfg.JWT.PrivateKeyPEM, cfg.JWT.PrivateKeyPEMPath)
	pub := loadPEM(cfg.JWT.PublicKeyPEM, cfg.JWT.PublicKeyPEMPath)
	s, err := jwt.NewSigner(priv, pub, cfg.JWT.Issuer, cfg.JWT.Audience)
	if err != nil {
		log.Fatalf("init jwt signer: %v", err)
	}
	return s
}

// PublicKeyPEMContent 返回验签公钥 PEM 的内容，解析规则与 LoadJWTSigner 完全一致
// （内联优先，否则读路径）。/v1/keys 分发的必须是签名者验签用的那一把：daemon 在
// login 时取走它、此后离线验签（R3），只读 PublicKeyPEM 字段会让「只配了
// public_key_pem_path」的部署（configs/config.example.yaml 的样子）分发出空串。
//
// 读不到时返回空串而不是退出：真正缺 key 的部署在 LoadJWTSigner 里就已经 Fatal 了
// （它跑在路由构建之前），这里再 Fatal 一次只会让测试里不配 JWT 的路由构造崩掉。
func (c JWTConfig) PublicKeyPEMContent() string {
	pem, _ := readPEM(c.PublicKeyPEM, c.PublicKeyPEMPath)
	return string(pem)
}

func loadPEM(inline, path string) []byte {
	b, err := readPEM(inline, path)
	if err != nil {
		log.Fatalf("%v", err)
	}
	return b
}

func readPEM(inline, path string) ([]byte, error) {
	if inline != "" {
		return []byte(inline), nil
	}
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read pem %s: %w", path, err)
		}
		return b, nil
	}
	return nil, errors.New("missing JWT key (need either inline PEM or file path)")
}

// RegisterDefaults 初始化 service 默认单例（OAuth、auth、device）。
func RegisterDefaults(cfg *ServerConfig, signer *jwt.Signer) {
	oauth_svc.SetDefaultGithub(oauth_svc.NewGithub(oauth_svc.GithubConfig{
		ClientID: cfg.OAuth.Github.ClientID, ClientSecret: cfg.OAuth.Github.ClientSecret,
		CallbackPath: cfg.OAuth.Github.CallbackPath, PublicURL: cfg.PublicURL,
	}))

	store := session.New(redis.Default(), cfg.Session.CookieName, int(cfg.Session.TTL/time.Second))
	auth_svc.SetDefault(auth_svc.New(store))

	device_svc.SetDefault(device_svc.New(device_svc.Config{
		UserCodeTTL:     cfg.DeviceFlow.UserCodeTTL,
		PollInterval:    cfg.DeviceFlow.PollInterval,
		AccessTTL:       cfg.JWT.AccessTTL,
		RefreshTTL:      cfg.JWT.RefreshTTL,
		VerificationURI: fmt.Sprintf("%s/device", strings.TrimRight(cfg.PublicURL, "/")),
	}, signer))

	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown-host"
	}
	relayConfig := relay_svc.Config{
		InstanceID: fmt.Sprintf("%s-%d-%d", hostname, os.Getpid(), time.Now().UnixNano()),
		OnlineTTL:  30 * time.Second,
	}
	relay_svc.SetDefault(relay_svc.New(
		relayConfig, device_repo.Device(), redis.Default(), relay_svc.NewRedisForwarder(relayConfig, redis.Default()),
	))
}
