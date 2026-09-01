// Package bootstrap 集中处理 agentre-server 的启动期组装：
//   - 从 env 注入敏感字段（cago 配置源不支持 env override）
//   - 加载 JWT 密钥
//   - 注册 GitHub OAuth client
//   - 初始化 auth_svc / device_svc 默认实例
package bootstrap

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/cago-frame/cago/configs"
	"github.com/cago-frame/cago/database/redis"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/relaywire"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/repository/device_repo"
	"github.com/agentre-hub/agentre-server/internal/service/accountchan_svc"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/mirror_svc"
	"github.com/agentre-hub/agentre-server/internal/service/oauth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/passkey_svc"
	"github.com/agentre-hub/agentre-server/internal/service/relay_svc"
	"github.com/agentre-hub/agentre-server/internal/service/saved_session_svc"
	"github.com/agentre-hub/agentre-server/internal/service/sessionimport_svc"
	"github.com/agentre-hub/agentre-server/internal/service/sync_svc"
	"github.com/agentre-hub/agentre-server/internal/service/user_svc"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

type ServerConfig struct {
	PublicURL       string            `yaml:"public_url"`
	InsecureCookies bool              `yaml:"insecure_cookies"`
	Session         SessionConfig     `yaml:"session"`
	DeviceFlow      DFConfig          `yaml:"device_flow"`
	JWT             JWTConfig         `yaml:"jwt"`
	OAuth           OAuthConfig       `yaml:"oauth"`
	RateLimit       RLConfig          `yaml:"rate_limit"`
	AccountGate     AccountGateConfig `yaml:"account_gate"`
	WebAuthn        WebAuthnConfig    `yaml:"webauthn"`
	DBPool          DBPoolConfig      `yaml:"db_pool"`
}

// DBPoolConfig 是 database/sql 连接池的参数。cago 的 db 组件不认这几项(它的
// Config 只有 driver/dsn/prefix/debug/prepareStmt),因此它们由 ApplyDBPool 在
// 数据库组件起来之后自己写进去。
//
// 不配等于用 database/sql 的默认值,而那套默认值对服务端是错的:
//   - MaxIdleConns 默认 2 —— 并发一上来就不停地建/拆 TCP + MySQL 握手;
//   - MaxOpenConns 默认无上限 —— 一次流量尖峰就能顶穿 MySQL 的 max_connections;
//   - ConnMaxLifetime 默认 0(永不过期)—— 主从切换后会一直攥着指向旧主的死连接。
//
// 多副本:MaxOpenConns 是**每个副本**的上限,调它之前先算「副本数 × 上限 ≤ MySQL
// 的 max_connections」,MySQL 那边默认只有 151。
type DBPoolConfig struct {
	MaxOpenConns    int           `yaml:"max_open_conns"`
	MaxIdleConns    int           `yaml:"max_idle_conns"`
	ConnMaxLifetime time.Duration `yaml:"conn_max_lifetime"`
	ConnMaxIdleTime time.Duration `yaml:"conn_max_idle_time"`
}

// ApplyDBPool 把连接池参数写进 database/sql。必须在 component.Database() 起来之后
// 调用:cago 的 db 组件在 Start 里建好 *gorm.DB,而这四项它的 Config 里根本没有,
// 于是不写就一直是 database/sql 的默认值(见 DBPoolConfig 的注释)。
func ApplyDBPool(sqlDB *sql.DB, pool DBPoolConfig) {
	sqlDB.SetMaxOpenConns(pool.MaxOpenConns)
	sqlDB.SetMaxIdleConns(pool.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(pool.ConnMaxLifetime)
	sqlDB.SetConnMaxIdleTime(pool.ConnMaxIdleTime)
}

// WebAuthnConfig 是通行密钥的 Relying Party 配置。
//
// RPID 与 Origins 缺省由 PublicURL 推导，但**必须能被配置覆盖**（决策 15）：开发态
// 前端在 5174、后端在 8443，浏览器给出的 origin 与 PublicURL 不是一个东西；e2e 又是
// 另一组端口。只按 PublicURL 推一个 origin，本地与 e2e 的 origin 校验必然过不去。
type WebAuthnConfig struct {
	// RPID 是 Relying Party ID，取有效域名（不带 scheme、不带端口）。
	RPID string `yaml:"rp_id"`
	// RPName 是认证器与密码管理器界面上显示的服务名。
	RPName string `yaml:"rp_name"`
	// Origins 是允许的完整 origin 列表（scheme://host[:port]）。
	Origins []string `yaml:"origins"`
	// MaxPerAccount 是每账号的通行密钥数量上限。
	MaxPerAccount int `yaml:"max_per_account"`
}

// AccountGateConfig 是账号闸门的配置。CacheTTL 就是「改库封禁后多久在所有入口失效」
// 的可观察上界：判定结论按它缓存在 Redis 里。
type AccountGateConfig struct {
	CacheTTL time.Duration `yaml:"cache_ttl"`
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
	ActiveKID  string         `yaml:"active_kid"`
	Keys       []JWTKeyConfig `yaml:"keys"`
	Issuer     string         `yaml:"issuer"`
	Audience   string         `yaml:"audience"`
	AccessTTL  time.Duration  `yaml:"access_ttl"`
	RefreshTTL time.Duration  `yaml:"refresh_ttl"`
}

type JWTKeyConfig struct {
	KID               string `yaml:"kid"`
	PrivateKeyPEMPath string `yaml:"private_key_pem_path"`
	PublicKeyPEMPath  string `yaml:"public_key_pem_path"`
}

type JWTPublicKeySet struct {
	CurrentKID string
	Keys       map[string]string
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
	AuthorizePerIPPerMin       int64 `yaml:"authorize_per_ip_per_min"`
	GithubAuthorizePerIPPerMin int64 `yaml:"github_authorize_per_ip_per_min"`
	GithubCallbackPerIPPerMin  int64 `yaml:"github_callback_per_ip_per_min"`
	// 通行密钥注册的 begin 端点：按 IP 与按账号各限一道。按 IP 挡匿名刷，按账号挡
	// 「同一个账号换出口接着刷」——注册要求已登录，光靠 IP 拦不住。
	PasskeyRegisterBeginPerIPPerMin      int64 `yaml:"passkey_register_begin_per_ip_per_min"`
	PasskeyRegisterBeginPerAccountPerMin int64 `yaml:"passkey_register_begin_per_account_per_min"`
	// 通行密钥登录的 begin 端点：只按 IP，因为此刻还没有账号可言（登录不要求任何
	// 标识）。计数前缀与注册那道分开——共用一个计数器的话，一次登录洪水会把注册
	// 一起锁死。
	PasskeyLoginBeginPerIPPerMin int64 `yaml:"passkey_login_begin_per_ip_per_min"`
}

// LoadServerConfig 从 cfg 取 server.* + env 覆盖，返回最终配置。
func LoadServerConfig(ctx context.Context, cfg *configs.Config) *ServerConfig {
	out := &ServerConfig{}
	if err := cfg.Scan(ctx, "server", out); err != nil {
		log.Fatalf("scan server config: %v", err)
	}
	setIfPresent("AGENTRE_SERVER_PUBLIC_URL", &out.PublicURL)
	setIfPresent("AGENTRE_SERVER_OAUTH_GITHUB_CLIENT_ID", &out.OAuth.Github.ClientID)
	setIfPresent("AGENTRE_SERVER_OAUTH_GITHUB_CLIENT_SECRET", &out.OAuth.Github.ClientSecret)
	setIfPresent("AGENTRE_SERVER_SESSION_SECRET", &out.Session.Secret)
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
	if out.DBPool.MaxOpenConns == 0 {
		out.DBPool.MaxOpenConns = 40
	}
	if out.DBPool.MaxIdleConns == 0 {
		out.DBPool.MaxIdleConns = 20
	}
	if out.DBPool.MaxIdleConns > out.DBPool.MaxOpenConns {
		// 空闲上限高于总上限没有意义,database/sql 也会自己压下来;这里显式对齐,
		// 免得配置读起来像是生效了。
		out.DBPool.MaxIdleConns = out.DBPool.MaxOpenConns
	}
	if out.DBPool.ConnMaxLifetime == 0 {
		out.DBPool.ConnMaxLifetime = 30 * time.Minute
	}
	if out.DBPool.ConnMaxIdleTime == 0 {
		out.DBPool.ConnMaxIdleTime = 5 * time.Minute
	}
	if out.RateLimit.AuthorizePerIPPerMin == 0 {
		out.RateLimit.AuthorizePerIPPerMin = 3
	}
	if out.RateLimit.GithubAuthorizePerIPPerMin == 0 {
		out.RateLimit.GithubAuthorizePerIPPerMin = 10
	}
	if out.RateLimit.GithubCallbackPerIPPerMin == 0 {
		out.RateLimit.GithubCallbackPerIPPerMin = 10
	}
	if out.RateLimit.PasskeyRegisterBeginPerIPPerMin == 0 {
		out.RateLimit.PasskeyRegisterBeginPerIPPerMin = 10
	}
	if out.RateLimit.PasskeyRegisterBeginPerAccountPerMin == 0 {
		out.RateLimit.PasskeyRegisterBeginPerAccountPerMin = 10
	}
	if out.RateLimit.PasskeyLoginBeginPerIPPerMin == 0 {
		out.RateLimit.PasskeyLoginBeginPerIPPerMin = 10
	}
	if out.AccountGate.CacheTTL <= 0 {
		out.AccountGate.CacheTTL = user_svc.DefaultGateCacheTTL
	}
	applyWebAuthnDefaults(out)
	return out
}

// applyWebAuthnDefaults 把没配的 WebAuthn 项按 PublicURL 补齐。
//
// 推导失败（PublicURL 空或不是个 URL）时留空：passkey_svc 会在构造时判出 RP 配置
// 不成立并让相关端点如实报错，而不是拿一个猜出来的 RP ID 去签发一批将来验不过的凭证。
func applyWebAuthnDefaults(out *ServerConfig) {
	public, err := url.Parse(out.PublicURL)
	if err != nil {
		public = &url.URL{}
	}
	if out.WebAuthn.RPID == "" {
		out.WebAuthn.RPID = public.Hostname()
	}
	if out.WebAuthn.RPName == "" {
		out.WebAuthn.RPName = "AgentRe"
	}
	if len(out.WebAuthn.Origins) == 0 && public.Scheme != "" && public.Host != "" {
		out.WebAuthn.Origins = []string{public.Scheme + "://" + public.Host}
	}
	if out.WebAuthn.MaxPerAccount <= 0 {
		out.WebAuthn.MaxPerAccount = passkey_svc.DefaultMaxPerAccount
	}
}

func setIfPresent(env string, dst *string) {
	if v := os.Getenv(env); v != "" {
		*dst = v
	}
}

// LoadJWTSigner 从 cfg.JWT 配置的路径读取 PEM 并构造 Signer。
func LoadJWTSigner(cfg *ServerConfig) *jwt.Signer {
	keys, activeKID := cfg.JWT.keyRing()
	jwtKeys := make([]jwt.Key, 0, len(keys))
	for _, key := range keys {
		var privatePEM []byte
		if key.PrivateKeyPEMPath != "" {
			privatePEM = loadPEM(key.PrivateKeyPEMPath)
		}
		jwtKeys = append(jwtKeys, jwt.Key{ID: key.KID, PrivatePEM: privatePEM,
			PublicPEM: loadPEM(key.PublicKeyPEMPath)})
	}
	s, err := jwt.NewKeyRing(activeKID, jwtKeys, cfg.JWT.Issuer, cfg.JWT.Audience, cfg.JWT.AccessTTL)
	if err != nil {
		log.Fatalf("init jwt signer: %v", err)
	}
	return s
}

// PublicKeyPEMContent 返回验签公钥 PEM 的内容，解析规则与 LoadJWTSigner 完全一致。
// /v1/keys 分发的必须是签名者验签用的那一把：daemon 在 login 时取走它、此后离线
// 验签（R3）。
//
// 读不到时返回空串而不是退出：真正缺 key 的部署在 LoadJWTSigner 里就已经 Fatal 了
// （它跑在路由构建之前），这里再 Fatal 一次只会让测试里不配 JWT 的路由构造崩掉。
func (c JWTConfig) PublicKeyPEMContent() string {
	set := c.PublicKeySet()
	return set.Keys[set.CurrentKID]
}

func (c JWTConfig) PublicKeySet() JWTPublicKeySet {
	keys, activeKID := c.keyRing()
	out := JWTPublicKeySet{CurrentKID: activeKID, Keys: make(map[string]string, len(keys))}
	for _, key := range keys {
		publicPEM, err := readPEM(key.PublicKeyPEMPath)
		if err == nil {
			out.Keys[key.KID] = string(publicPEM)
		}
	}
	return out
}

func (c JWTConfig) keyRing() ([]JWTKeyConfig, string) {
	return c.Keys, c.ActiveKID
}

func loadPEM(path string) []byte {
	b, err := readPEM(path)
	if err != nil {
		log.Fatalf("%v", err)
	}
	return b
}

func readPEM(path string) ([]byte, error) {
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read pem %s: %w", path, err)
		}
		return b, nil
	}
	return nil, errors.New("missing JWT key file path")
}

// RegisterDefaults 初始化 service 默认单例（OAuth、auth、device）。
func RegisterDefaults(cfg *ServerConfig, signer *jwt.Signer) {
	oauth_svc.SetDefaultGithub(oauth_svc.NewGithub(oauth_svc.GithubConfig{
		ClientID: cfg.OAuth.Github.ClientID, ClientSecret: cfg.OAuth.Github.ClientSecret,
		CallbackPath: cfg.OAuth.Github.CallbackPath, PublicURL: cfg.PublicURL,
	}))

	store := session.New(redis.Default(), cfg.Session.CookieName, int(cfg.Session.TTL/time.Second))
	auth_svc.SetDefault(auth_svc.New(store))

	// 账号闸门：session / device JWT / relay 三条鉴权路径与中继心跳共用的那一处判定。
	// 没有它，四条路径会退回「凭据有效就放行」，改库封禁只挡得住新的登录。
	user_svc.SetGate(user_svc.NewGate(redis.Default(), cfg.AccountGate.CacheTTL))

	// 通行密钥：challenge 存 Redis（决策 14），begin 与 finish 因此可以落在不同副本上。
	passkey_svc.SetDefault(passkey_svc.New(redis.Default(), passkey_svc.Config{
		RPID:          cfg.WebAuthn.RPID,
		RPDisplayName: cfg.WebAuthn.RPName,
		Origins:       cfg.WebAuthn.Origins,
		MaxPerAccount: cfg.WebAuthn.MaxPerAccount,
	}))

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
	// 总览页「当前生效」那一档要问 daemon 是否在线；workspace_svc 只依赖窄接口
	// DaemonOnlineChecker（ISP），relay_svc.Default() 结构性满足它。
	workspace_svc.SetOnlineChecker(relay_svc.Default())

	// 账号级实时通道：只需要 Redis。它不寻址到实例（广播是一对多的 Pub/Sub），
	// 因此不像中继那样要一个进程内唯一的 InstanceID。
	accountchan_svc.SetDefault(accountchan_svc.New(redis.Default()))

	registerSessionMirror(relayConfig.InstanceID, signer)
}

// registerSessionMirror 把账号会话镜像的三根线接上（规格
// 2026-08-18-server-session-mirror）：本进程那份常驻、保存 / 删除这一侧的两个消费侧
// 接口，以及撤销设备时的连带清理。
//
// 常驻的三个依赖都从这里注入（DIP）：中继取 relay_svc.Default()、签名器就是
// device_svc / device_ctr 在用的那把、Redis 取 redis.Default()。InstanceID 与
// relay_svc 共用同一个「一进程一份」的值——它是租约里的持有者标识，两个副本共用一个
// 值会让彼此的续期都成功，同一台机器因此被跟两遍。
func registerSessionMirror(instanceID string, signer *jwt.Signer) {
	supervisor := mirror_svc.NewSupervisor(
		mirror_svc.Config{InstanceID: instanceID}, relay_svc.Default(), signer, redis.Default())
	mirror_svc.SetDefault(supervisor)
	sessions := mirror_svc.NewSessions(supervisor)
	saved_session_svc.SetSessionMirror(sessionMirror{sessions: sessions})
	saved_session_svc.SetPeerSessionDeleter(peerSessionDeleter{sessions: sessions})
	// 导入本地会话（规格 2026-08-26）：两根线同样接在这里。「够到那台机器」的实现
	// 在 mirror_svc（它才知道怎么拨中继），「把导出来的会话收进账号」的实现在
	// saved_session_svc（它才是保存名单的主人）；sessionimport_svc 两边都不 import。
	sessionimport_svc.SetDefault(sessionimport_svc.New(
		machineImports{imports: mirror_svc.NewImports(supervisor)},
		savedSessions{follows: saved_session_svc.Default()},
	))
	// 工作区多端同步 R14 / R18 + 会话镜像决策 7：撤销一台设备时的三件连带清理分属
	// 两个域，device_svc 只认那个窄接口，由这里拼齐。
	device_svc.SetDeviceDataPurger(revokePurger{sync: sync_svc.Default(), mirror: sessions})
}

// sessionMirror / peerSessionDeleter 把 saved_session_svc 的保存 / 删除接到 mirror_svc 上。
// 接口在消费侧（saved_session_svc）声明、实现在 mirror_svc，两个 service 谁都不 import 谁；
// 这里是唯一同时认识两边的地方，也就是组合根该干的活。
type sessionMirror struct{ sessions *mirror_svc.Sessions }

func (m sessionMirror) Begin(ctx context.Context, ref saved_session_svc.SessionRef) error {
	// 开始镜像要连的是**承载它的机器**。
	return m.sessions.Begin(ctx, ref.UserID, ref.MachineFingerprint, ref.ConversationID)
}

func (m sessionMirror) Purge(ctx context.Context, ref saved_session_svc.SessionRef) error {
	// 摘连接要认得那台机器（承载它的那一台），清库按的是 conversation_id ——
	// 四张镜像表就是照它存的。
	return m.sessions.Purge(ctx, ref.UserID, ref.MachineFingerprint, ref.ConversationID)
}

type peerSessionDeleter struct{ sessions *mirror_svc.Sessions }

// DeleteOnPeer 把传输层失败翻译成 saved_session_svc 的业务判据。
func (d peerSessionDeleter) DeleteOnPeer(ctx context.Context, ref saved_session_svc.SessionRef) error {
	// 拨的是承载它的那台机器。
	err := d.sessions.DeleteOnPeer(ctx, ref.UserID, ref.MachineFingerprint, ref.ConversationID)
	switch {
	case errors.Is(err, mirror_svc.ErrMachineOffline):
		return saved_session_svc.ErrPeerOffline
	case isMethodNotFound(err):
		return fmt.Errorf("%w: %v", saved_session_svc.ErrPeerProtocolViolation, err)
	default:
		return err
	}
}

// machineImports / savedSessions 把 sessionimport_svc 的两个消费侧接口接到实现上。
// 与上面那两位同理：接口在消费侧声明、实现各在自己的域里，这里是唯一同时认识
// 三边的地方。
type machineImports struct{ imports *mirror_svc.Imports }

// WithPeer 只翻译机器离线；协议方法缺失作为普通协议错误原样上交。
func (m machineImports) WithPeer(
	ctx context.Context, userID int64, fingerprint string,
	fn func(context.Context, sessionimport_svc.TranscriptImportPeer) error,
) error {
	err := m.imports.WithPeer(ctx, userID, fingerprint,
		func(ctx context.Context, peer mirror_svc.TranscriptImportPeer) error {
			return fn(ctx, peer)
		})
	switch {
	case errors.Is(err, mirror_svc.ErrMachineOffline):
		return sessionimport_svc.ErrMachineOffline
	default:
		return err
	}
}

func isMethodNotFound(err error) bool {
	var wireErr *relaywire.Error
	return errors.As(err, &wireErr) && wireErr.Code == relaywire.CodeMethodNotFound
}

type savedSessions struct {
	follows saved_session_svc.SavedSessionSvc
}

// Save 把导出来的那条会话收进账号，于是镜像对它开始。两个指纹同值：导入由那台
// 机器自己执行，会话也归它（见 sessionimport_svc.Import 的说明）。
func (s savedSessions) Save(ctx context.Context, ref sessionimport_svc.SessionRef) error {
	return s.follows.Save(ctx, saved_session_svc.SessionRef{
		UserID:             ref.UserID,
		MachineFingerprint: ref.MachineFingerprint,
		PeerFingerprint:    ref.PeerFingerprint,
		ConversationID:     ref.ConversationID,
	})
}

// revokePurger 是撤销一台设备时那几件连带清理的合体：本机路径清单与账号级同步对象
// 在 sync_svc，挂在这台机器上、此后永远执行不了的会话删除待办在 mirror_svc。
type revokePurger struct {
	sync   sync_svc.SyncSvc
	mirror *mirror_svc.Sessions
}

func (p revokePurger) PurgeDeviceLocalPaths(ctx context.Context, deviceID int64) error {
	return p.sync.PurgeDeviceLocalPaths(ctx, deviceID)
}

func (p revokePurger) PurgeDeviceSyncObjects(ctx context.Context, userID int64, fingerprint string) error {
	return p.sync.PurgeDeviceSyncObjects(ctx, userID, fingerprint)
}

func (p revokePurger) PurgeDeviceDeleteTodos(ctx context.Context, userID int64, fingerprint string) error {
	return p.mirror.PurgeMachineDeleteTodos(ctx, userID, fingerprint)
}

var (
	_ saved_session_svc.SessionMirror      = sessionMirror{}
	_ saved_session_svc.PeerSessionDeleter = peerSessionDeleter{}
	_ device_svc.DeviceDataPurger          = revokePurger{}
)
