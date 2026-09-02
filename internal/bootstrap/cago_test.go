package bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/configs/memory"
	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/service/passkey_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
)

func TestLoadServerConfig_AccessTTLDefaultIsMinuteLevel(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
	})))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, 15*time.Minute, got.JWT.AccessTTL)
	assert.Less(t, got.JWT.AccessTTL, time.Hour, "R4 要求访问凭据为分钟级短有效期")
	assert.Equal(t, 90*24*time.Hour, got.JWT.RefreshTTL)
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
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	assert.NoError(t, err)
	user_svc.SetGate(nil)
	t.Cleanup(func() { user_svc.SetGate(nil) })

	RegisterDefaults(&ServerConfig{AccountGate: AccountGateConfig{CacheTTL: time.Minute}}, signer)

	assert.NotNil(t, user_svc.Gate(), "RegisterDefaults 必须装配账号闸门")
}

// 与闸门同一个失败模式，只是这次是 service 单例：passkey_svc.Default() 在没人
// SetDefault 过时是一个 nil 接口，通行密钥的六个端点第一次被调用就空指针 panic
// ——而且只在生产上 panic，单测自己会 SetDefault(stub)，整套测试永远绿。
// repository 那一类已经由 cmd/server/repository_wiring_test.go 整类钉住，
// service 单例目前还是一条一条钉。
func TestRegisterDefaults_InstallsPasskeyService(t *testing.T) {
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	assert.NoError(t, err)
	passkey_svc.SetDefault(nil)
	t.Cleanup(func() { passkey_svc.SetDefault(nil) })

	RegisterDefaults(&ServerConfig{
		WebAuthn: WebAuthnConfig{RPID: "localhost", RPName: "AgentRe", Origins: []string{"http://localhost"}},
	}, signer)

	assert.NotNil(t, passkey_svc.Default(), "RegisterDefaults 必须装配通行密钥服务")
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
	assert.NotEmpty(t, got.WebAuthn.RPName)
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
			"  webauthn:\n    rp_id: \"localhost\"\n    rp_name: \"AgentRe Dev\"\n"+
			"    origins:\n      - \"http://localhost:5174\"\n      - \"http://localhost:8443\"\n"+
			"    max_per_account: 3\n"+
			"  rate_limit:\n    passkey_register_begin_per_ip_per_min: 7\n"+
			"    passkey_register_begin_per_account_per_min: 5\n"), 0o600))
	cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, "localhost", got.WebAuthn.RPID)
	assert.Equal(t, "AgentRe Dev", got.WebAuthn.RPName)
	assert.Equal(t, []string{"http://localhost:5174", "http://localhost:8443"}, got.WebAuthn.Origins)
	assert.Equal(t, 3, got.WebAuthn.MaxPerAccount)
	assert.Equal(t, int64(7), got.RateLimit.PasskeyRegisterBeginPerIPPerMin)
	assert.Equal(t, int64(5), got.RateLimit.PasskeyRegisterBeginPerAccountPerMin)
}

// 连接池不配就是 database/sql 的默认值:MaxIdleConns=2、MaxOpenConns 无上限。
// 前者让并发一上来就不停地建/拆 TCP + MySQL 握手,后者让一次流量尖峰能把 MySQL
// 的 max_connections 顶穿。cago 的 db 组件自己从不调用这三个 setter(它的 Config
// 里根本没有这几个字段),所以缺省值只能在这里给。
func TestLoadServerConfig_DBPoolHasBoundedDefaults(t *testing.T) {
	cfg, err := configs.NewConfig("agentre-server", configs.WithSource(memory.NewSource(map[string]interface{}{
		"server": map[string]interface{}{},
	})))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Positive(t, got.DBPool.MaxOpenConns, "连接数必须有上限,否则尖峰会顶穿 MySQL")
	assert.Greater(t, got.DBPool.MaxIdleConns, 2,
		"空闲上限停在 database/sql 的默认 2 会让并发下不停重建连接")
	assert.LessOrEqual(t, got.DBPool.MaxIdleConns, got.DBPool.MaxOpenConns)
	assert.Positive(t, got.DBPool.ConnMaxLifetime,
		"连接必须有寿命,否则主从切换后会一直攥着指向旧主的死连接")
	assert.Positive(t, got.DBPool.ConnMaxIdleTime)
}

// 走真实 YAML:键名对不上的话,运维按副本数调完池子也不生效。
func TestLoadServerConfig_DBPoolIsConfigurable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	assert.NoError(t, os.WriteFile(path, []byte(
		"env: dev\ndebug: true\nsource: file\nserver:\n  db_pool:\n"+
			"    max_open_conns: 7\n    max_idle_conns: 3\n"+
			"    conn_max_lifetime: 90s\n    conn_max_idle_time: 30s\n"), 0o600))
	cfg, err := configs.NewConfig("agentre-server", configs.WithConfigFile(path))
	assert.NoError(t, err)

	got := LoadServerConfig(context.Background(), cfg)

	assert.Equal(t, 7, got.DBPool.MaxOpenConns)
	assert.Equal(t, 3, got.DBPool.MaxIdleConns)
	assert.Equal(t, 90*time.Second, got.DBPool.ConnMaxLifetime)
	assert.Equal(t, 30*time.Second, got.DBPool.ConnMaxIdleTime)
}

// ApplyDBPool 是「配置读出来了」与「database/sql 真的收到了」之间的那一段。
// 缺了它,上面两个用例全绿而池子仍然是默认值。
func TestApplyDBPool_WritesLimitsIntoSQLDB(t *testing.T) {
	sqlDB, mock, err := sqlmock.New()
	assert.NoError(t, err)
	mock.ExpectClose()
	t.Cleanup(func() { assert.NoError(t, sqlDB.Close()) })

	ApplyDBPool(sqlDB, DBPoolConfig{
		MaxOpenConns: 7, MaxIdleConns: 3,
		ConnMaxLifetime: 90 * time.Second, ConnMaxIdleTime: 30 * time.Second,
	})

	// database/sql 只把连接数上限暴露在 Stats 上,空闲上限与寿命没有公开读法。
	assert.Equal(t, 7, sqlDB.Stats().MaxOpenConnections)
}
