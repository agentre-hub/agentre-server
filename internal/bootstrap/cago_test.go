package bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/configs/memory"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/passkey_svc"
	"github.com/agentre-hub/agentre-server/internal/service/portforward_svc"
	"github.com/agentre-hub/agentre-server/internal/service/release_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

func TestLoadServerConfig_AccessTTLDefaultIsWithinBound(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
	})))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, 2*time.Hour, got.Token.AccessTTL)
	assert.LessOrEqual(t, got.Token.AccessTTL, 2*time.Hour,
		"access token 的有效期就是被盗凭据的存活窗口，上限 2h")
	assert.Equal(t, 30*24*time.Hour, got.Token.RefreshTTL)
}

// 不透明凭据不再靠密钥验签，令牌有效期从 server.jwt.{access_ttl,refresh_ttl} 搬到
// server.token.{access_ttl,refresh_ttl}（task 13）。升级后的配置中心/配置文件仍可能
// 残留旧的 server.jwt 段（含已经没有读者的 active_kid / keys）——mapstructure.Decode
// 对不认识的键本就不报错，但这里钉住这一点：残留旧段不应让启动失败，也不应该悄悄
// 顶替新位置的缺省值。
func TestLoadServerConfig_LeftoverServerJWTBlockDoesNotBreakLoading(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{
			"jwt": map[string]interface{}{
				"active_kid": "2026-08-a",
				"keys": []interface{}{
					map[string]interface{}{
						"kid":                  "2026-08-a",
						"private_key_pem_path": "/etc/agentre-server/keys/2026-08-a.key",
						"public_key_pem_path":  "/etc/agentre-server/keys/2026-08-a.pub",
					},
				},
				"access_ttl":  "999999h",
				"refresh_ttl": "999999h",
			},
		},
	})))
	require.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, 2*time.Hour, got.Token.AccessTTL,
		"残留的 server.jwt.access_ttl 不应顶替 server.token 的缺省值")
	assert.Equal(t, 30*24*time.Hour, got.Token.RefreshTTL,
		"残留的 server.jwt.refresh_ttl 不应顶替 server.token 的缺省值")
}

func TestLoadServerConfig_DoesNotReadRemovedHubRoot(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
		"hub":    map[string]interface{}{"public_url": "https://legacy.example"},
	})))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Empty(t, got.PublicURL)
}

// 闸门缓存 TTL 决定「改库封禁后多久在所有入口失效」这个可观察上界，配置缺省时必须
// 落到 60 秒，而不是 0——0 会让 Redis 里的判定结论永不过期，封禁就再也生效不了。
func TestLoadServerConfig_AccountGateCacheTTLDefaultsToOneMinute(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
	})))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, time.Minute, got.AccountGate.CacheTTL)
}

// 走真实的 YAML 文件源：configs/*.yaml 里写的是 server.account_gate.cache_ttl，
// 键名对不上的话运维改了配置也不生效，而内存源（JSON 编解码）根本表达不出这个键。
func TestLoadServerConfig_AccountGateCacheTTLIsConfigurable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	assert.NoError(t, os.WriteFile(path, []byte(
		"env: dev\ndebug: true\nsource: file\nserver:\n  account_gate:\n    cache_ttl: 5s\n"), 0o600))
	cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, 5*time.Second, got.AccountGate.CacheTTL)
}

// 中间件与中继心跳在闸门未装配时按「不判定」处理（判定无从做起），因此「生产上一定
// 装配」这件事必须由这里钉住：漏了它，四条鉴权路径会安静地退回封禁前的行为。
func TestRegisterDefaults_InstallsAccountGate(t *testing.T) {
	testutils.Redis(t)
	user_svc.SetGate(nil)
	t.Cleanup(func() { user_svc.SetGate(nil) })

	RegisterDefaults(&ServerConfig{AccountGate: AccountGateConfig{CacheTTL: time.Minute}})

	assert.NotNil(t, user_svc.Gate(), "RegisterDefaults 必须装配账号闸门")
}

// S6：服务启动不再需要任何密钥文件。配置里没有任何签名密钥，默认实例照常装配，
// 浏览器票据照常签发、照常由 server 的记录核验。
func TestRegisterDefaults_NeedsNoKeyMaterial(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
	})))
	require.NoError(t, err)

	RegisterDefaults(LoadServerConfig(ctx, cfg))

	auth := auth_svc.Default()
	require.NotNil(t, auth)
	sid, _, err := auth.StartSession(ctx, 7)
	require.NoError(t, err)
	ticket, err := auth.IssueRelayTicket(ctx, sid, 7)
	require.NoError(t, err)
	p, err := auth.ResolveCredential(ctx, ticket.Token)
	require.NoError(t, err)
	assert.Equal(t, credstore.KindRelayClient, p.Kind)
}

// 与闸门同一个失败模式，只是这次是 service 单例：passkey_svc.Default() 在没人
// SetDefault 过时是一个 nil 接口，通行密钥的六个端点第一次被调用就空指针 panic
// ——而且只在生产上 panic，单测自己会 SetDefault(stub)，整套测试永远绿。
// repository 那一类已经由 cmd/server/repository_wiring_test.go 整类钉住，
// service 单例目前还是一条一条钉。
func TestRegisterDefaults_InstallsPasskeyService(t *testing.T) {
	testutils.Redis(t)
	passkey_svc.SetDefault(nil)
	t.Cleanup(func() { passkey_svc.SetDefault(nil) })

	RegisterDefaults(&ServerConfig{
		WebAuthn: WebAuthnConfig{RPID: "localhost", RPName: "Agentre", Origins: []string{"http://localhost"}},
	})

	assert.NotNil(t, passkey_svc.Default(), "RegisterDefaults 必须装配通行密钥服务")
}

// 端口转发的连接池与镜像那份常驻同一个失败模式：没人装配时 portforward_svc.Default()
// 是 nil，而 /fw/ 那条路由第一次被打开就空指针 panic——只在生产上 panic，单测自己
// 会 New 一个池，整套测试永远绿。
func TestRegisterDefaults_InstallsPortForwardPool(t *testing.T) {
	testutils.Redis(t)
	portforward_svc.SetDefault(nil)
	t.Cleanup(func() { portforward_svc.SetDefault(nil) })

	RegisterDefaults(&ServerConfig{})

	assert.NotNil(t, portforward_svc.Default(), "RegisterDefaults 必须装配端口转发连接池")
}

// RP ID 与允许的 origin 缺省由 public_url 推导：绝大多数部署前后端同域同端口，
// 让它们多写一遍纯属找错。
func TestLoadServerConfig_WebAuthnDefaultsDeriveFromPublicURL(t *testing.T) {
	// 走文件源而不是内存源：内存源是 JSON 编解码，表达不出 public_url 这个 yaml 键
	// （既有 account_gate 的用例已经记下这件事）。
	path := filepath.Join(t.TempDir(), "config.yaml")
	assert.NoError(t, os.WriteFile(path, []byte(
		"env: dev\ndebug: true\nsource: file\nserver:\n  public_url: \"https://server.agentre.dev\"\n"), 0o600))
	cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, "server.agentre.dev", got.WebAuthn.RPID, "RP ID 是主机名，不带 scheme 和端口")
	assert.Equal(t, []string{"https://server.agentre.dev"}, got.WebAuthn.Origins)
	assert.Equal(t, "Agentre", got.WebAuthn.RPName, "没配 rp_name 时，通行密钥弹窗里显示的是产品名")
	assert.Positive(t, got.WebAuthn.MaxPerAccount)
	assert.Positive(t, got.RateLimit.PasskeyRegisterBeginPerIPPerMin)
	assert.Positive(t, got.RateLimit.PasskeyRegisterBeginPerAccountPerMin)
}

// 走真实 YAML 文件源，把键名钉住：开发态前端在 5174、后端在 8443，e2e 又是另一组
// 端口，只按 public_url 推一个 origin 会让本地与 e2e 全部验不过（决策 15）。运维
// 必须能把多个 origin 写进配置，键名对不上就等于这条路根本不存在。
func TestLoadServerConfig_WebAuthnIsConfigurable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	assert.NoError(t, os.WriteFile(path, []byte(
		"env: dev\ndebug: true\nsource: file\nserver:\n  public_url: \"https://server.agentre.dev\"\n"+
			"  webauthn:\n    rp_id: \"localhost\"\n    rp_name: \"Agentre Dev\"\n"+
			"    origins:\n      - \"http://localhost:5174\"\n      - \"http://localhost:8443\"\n"+
			"    max_per_account: 3\n"+
			"  rate_limit:\n    passkey_register_begin_per_ip_per_min: 7\n"+
			"    passkey_register_begin_per_account_per_min: 5\n"), 0o600))
	cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, "localhost", got.WebAuthn.RPID)
	assert.Equal(t, "Agentre Dev", got.WebAuthn.RPName)
	assert.Equal(t, []string{"http://localhost:5174", "http://localhost:8443"}, got.WebAuthn.Origins)
	assert.Equal(t, 3, got.WebAuthn.MaxPerAccount)
	assert.Equal(t, int64(7), got.RateLimit.PasskeyRegisterBeginPerIPPerMin)
	assert.Equal(t, int64(5), got.RateLimit.PasskeyRegisterBeginPerAccountPerMin)
}

// release.cache_ttl 缺省时必须落到 release_svc.DefaultCacheTTL,而不是 0——0 会让
// Redis 里的缓存值永不过期,一次拉取失败之后端点也就再也不会自然退回「不知道」。
// enabled 缺省时必须是 false：cago 的 Scan 分不出「配置没写这个键」与「显式写了
// false」,只能在两者中选一个安全的默认——未部署上游镜像的场景不该在没人要求的情况
// 下就开始往外发请求。
func TestLoadServerConfig_ReleaseHasSafeDefaults(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
	})))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.False(t, got.Release.Enabled)
	assert.Equal(t, release_svc.DefaultCacheTTL, got.Release.CacheTTL)
	assert.Empty(t, got.Release.BaseURL)
}

// 走真实的 YAML 文件源：configs/*.yaml 里写的是 server.release.*,键名对不上的话运维
// 打开开关也不生效。
func TestLoadServerConfig_ReleaseIsConfigurable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	assert.NoError(t, os.WriteFile(path, []byte(
		"env: dev\ndebug: true\nsource: file\nserver:\n  release:\n"+
			"    enabled: true\n    base_url: \"https://mirror.example/latest\"\n    cache_ttl: 5m\n"), 0o600))
	cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.True(t, got.Release.Enabled)
	assert.Equal(t, "https://mirror.example/latest", got.Release.BaseURL)
	assert.Equal(t, 5*time.Minute, got.Release.CacheTTL)
}

// 生产上一定装配:漏了它,/v1/release/latest 会在 release_svc.Release() 上拿到 nil,
// 控制器眼下会把它当「不知道」处理而不炸,但那样这条链路就从来没有真的跑起来过。
func TestRegisterDefaults_InstallsReleaseService(t *testing.T) {
	testutils.Redis(t)
	release_svc.SetDefault(nil)
	t.Cleanup(func() { release_svc.SetDefault(nil) })

	RegisterDefaults(&ServerConfig{Release: ReleaseConfig{CacheTTL: time.Hour}})

	assert.NotNil(t, release_svc.Release(), "RegisterDefaults 必须装配 release 服务")
}

// Cookie 上的 Secure 由 public_url 的 scheme 决定，不是一个独立的开关。
//
// 两者对不上时没有任何一层会报错，症状还都不像配置问题：https 上关掉 Secure 是一次
// 静默降级；http 上开着 Secure 则是浏览器根本不回传 cookie，表现为「登录了但一直没
// 登上」。既然写错的两种方式都无声,就别留下写错的余地——与 webauthn 的 rp_id /
// origins 同一个处理。
func TestLoadServerConfig_InsecureCookiesFollowPublicURLScheme(t *testing.T) {
	load := func(t *testing.T, body string) *ServerConfig {
		t.Helper()
		path := filepath.Join(t.TempDir(), "config.yaml")
		assert.NoError(t, os.WriteFile(path,
			[]byte("env: dev\ndebug: true\nsource: file\nserver:\n"+body), 0o600))
		cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
		assert.NoError(t, err)
		return LoadServerConfig(context.Background(), cfg)
	}

	assert.True(t, load(t, "  public_url: \"http://localhost:8443\"\n").InsecureCookies,
		"http 上必须去掉 Secure，否则浏览器不回传 cookie，登录永远不生效")
	assert.False(t, load(t, "  public_url: \"https://server.agentre.dev\"\n").InsecureCookies,
		"https 上必须带 Secure")

	// 配置里写死的开关不再有话语权：留着它就等于留着「和 scheme 写反」这一种配错法。
	assert.False(t, load(t,
		"  public_url: \"https://server.agentre.dev\"\n  insecure_cookies: true\n").InsecureCookies,
		"insecure_cookies 已不是配置项，https 上写 true 也不该关掉 Secure")

	// public_url 缺失或不是个 http(s) 地址时按安全的一侧兜底：宁可 cookie 带 Secure
	// 让人当场看见登录不生效，也不要在一台不知道自己是谁的服务上悄悄发出裸 cookie。
	assert.False(t, load(t, "  public_url: \"\"\n").InsecureCookies)
}

// device_flow_ttl 定的是整条设备流记录的寿命——user_code 与 device_code 共用同一个
// expires_at（device_svc.Authorize 写、ExchangeToken 按它拒绝 device_code），
// 也是回给客户端的 RFC 8628 expires_in。旧键名 user_code_ttl 只说了其中一半，
// 调它的人会以为只在缩短用户码，因此已作废。
func TestLoadServerConfig_DeviceFlowTTL(t *testing.T) {
	load := func(t *testing.T, deviceFlowYAML string) *ServerConfig {
		t.Helper()
		path := filepath.Join(t.TempDir(), "config.yaml")
		require.NoError(t, os.WriteFile(path, []byte(
			"env: dev\ndebug: true\nsource: file\nserver:\n  device_flow:\n"+deviceFlowYAML), 0o600))
		cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
		require.NoError(t, err)
		return LoadServerConfig(context.Background(), cfg)
	}

	t.Run("新键 device_flow_ttl 生效", func(t *testing.T) {
		assert.Equal(t, 3*time.Minute, load(t, "    device_flow_ttl: 3m\n").DeviceFlow.FlowTTL)
	})
	t.Run("都不写落到 10 分钟", func(t *testing.T) {
		assert.Equal(t, 10*time.Minute, load(t, "    poll_interval: 5s\n").DeviceFlow.FlowTTL)
	})
}
