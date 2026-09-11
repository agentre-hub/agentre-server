// Package auth_svc 维护浏览器 session 与 OAuth state。
package auth_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

type OAuthStatePayload struct {
	Next      string `json:"next"`
	UserCode  string `json:"user_code"`
	IP        string `json:"ip"`
	CreatedAt int64  `json:"created_at"`
}

type AuthSvc interface {
	CreateOAuthState(ctx context.Context, p OAuthStatePayload) (string, error)
	ConsumeOAuthState(ctx context.Context, state string) (*OAuthStatePayload, error)

	// StartSession 建立浏览器 session。client 记下这次登录的 UA 与 IP，供会话清单
	// 展示；来源不是 HTTP 请求时（测试装置）可以不给。
	StartSession(ctx context.Context, userID int64, client ...session.Client) (sid string, sess *session.Session, err error)
	GetSession(ctx context.Context, sid string) (*session.Session, error)
	EndSession(ctx context.Context, sid string) error
	// ListSessions 列出该账号当前全部登录会话，最近活动的在前。
	ListSessions(ctx context.Context, userID int64) ([]session.Info, error)
	// EndOtherSessions 结束该账号除 currentSID 之外的全部会话，返回实际撤销的条数。
	EndOtherSessions(ctx context.Context, userID int64, currentSID string) (int, error)
	// IssueRelayTicket 用这次浏览器登录会话换一张中继票据，见实现处说明。
	IssueRelayTicket(ctx context.Context, sid string, userID int64) (*RelayTicket, error)
	// ResolveCredential 解析一张 server 签发的短效凭据（中继票据或 server 自用凭据），
	// 见实现处说明。设备 access token 不在此列，它由 device_svc 解析。
	ResolveCredential(ctx context.Context, token string) (*device_svc.Principal, error)
	// WatchRelayCredential 取一条**已经建好**的中继连接的撤销判定，见实现处说明。
	WatchRelayCredential(ctx context.Context, handle string) RelayCredentialWatch
	CookieName() string
}

// RelayTicket 是换给浏览器的中继票据：凭据本身、它代表的网页对端身份与有效期。
type RelayTicket struct {
	Token           string
	PeerFingerprint string
	ExpiresIn       time.Duration
}

// ErrCredentialUnverifiable 表示短效凭据此刻判不出真假（存储不可用）。它不是「凭据无效」，
// 由调用方决定怎么 fail-closed。
var ErrCredentialUnverifiable = errors.New("short-lived credential cannot be verified")

// RelayCredentialWatch 是一条已经建好的中继连接的撤销判定：连接的心跳反复调用它，
// 返回 true 表示背后的凭据已被撤销、这条连接必须断开。
type RelayCredentialWatch func(ctx context.Context) bool

type authSvc struct {
	redis       *goredis.Client
	credentials *credstore.Store
	store       *session.Store
}

// New 接收这个 service 要用的 Redis 客户端，不去够 redis.Default()。
//
// 与 session.Store / passkey_svc / user_svc.Gate 同一形状：全局单例只在组合根
// （bootstrap.RegisterDefaults）出现一次，其余各层拿到的都是构造时注入的那一个。
func New(rc *goredis.Client, store *session.Store) AuthSvc {
	return &authSvc{redis: rc, credentials: credstore.New(rc), store: store}
}

var defaultSvc AuthSvc

func Default() AuthSvc     { return defaultSvc }
func SetDefault(s AuthSvc) { defaultSvc = s }

const oauthStateTTL = 10 * time.Minute

func (s *authSvc) CreateOAuthState(ctx context.Context, p OAuthStatePayload) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	state := base64.RawURLEncoding.EncodeToString(buf)
	p.CreatedAt = time.Now().UnixMilli()
	body, _ := json.Marshal(p)
	if err := s.redis.Set(ctx, "oauth_state:"+state, body, oauthStateTTL).Err(); err != nil {
		return "", err
	}
	return state, nil
}

func (s *authSvc) ConsumeOAuthState(ctx context.Context, state string) (*OAuthStatePayload, error) {
	if state == "" {
		return nil, nil
	}
	key := "oauth_state:" + state
	val, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, goredis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = s.redis.Del(ctx, key).Err()
	var p OAuthStatePayload
	if err := json.Unmarshal(val, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *authSvc) StartSession(ctx context.Context, userID int64,
	client ...session.Client) (string, *session.Session, error) {
	var c session.Client
	if len(client) > 0 {
		c = client[0]
	}
	sid, sess, err := s.store.Create(ctx, userID, c)
	if err == nil {
		logger.Ctx(ctx).Info("session started", zap.Int64("userId", userID), zap.String("sessionId", sid))
	}
	return sid, sess, err
}

func (s *authSvc) GetSession(ctx context.Context, sid string) (*session.Session, error) {
	return s.store.Get(ctx, sid)
}

// EndSession 结束一次登录。这次会话换出的中继票据随之失效：票据的解析与已建连接的复查
// 都以签发它的会话仍然存在为前提，删掉会话就是撤票，不需要另写一份撤销记录。
func (s *authSvc) EndSession(ctx context.Context, sid string) error {
	if err := s.store.Delete(ctx, sid); err != nil {
		return err
	}
	logger.Ctx(ctx).Info("session ended", zap.String("sessionId", sid))
	return nil
}

func (s *authSvc) ListSessions(ctx context.Context, userID int64) ([]session.Info, error) {
	return s.store.ListByUser(ctx, userID)
}

// EndOtherSessions 结束该账号除当前会话外的全部登录，返回实际撤销的条数。
//
// 逐条与 EndSession 同一个结论（会话没了，它换出的票也就失效了），差别只在这里是尽力而为：
// 单条失败记 warn 并继续，不把整次操作报成失败。用户点了「登出其它全部」就该尽量做成，
// 一条删不掉不该让已经登出的那几条显得没生效；他可以再点一次，清单会如实反映还剩几条。
func (s *authSvc) EndOtherSessions(ctx context.Context, userID int64, currentSID string) (int, error) {
	list, err := s.store.ListByUser(ctx, userID)
	if err != nil {
		// 列不出来就一条也撤不了，这个要如实报错：假装「撤销了 0 条」会让用户以为
		// 名下只剩当前这一条登录。
		return 0, err
	}
	revoked := 0
	for _, info := range list {
		if info.SID == currentSID {
			continue
		}
		if err := s.store.Delete(ctx, info.SID); err != nil {
			logger.Ctx(ctx).Warn("auth_svc.EndOtherSessions: 删除会话失败，其余继续",
				zap.Int64("userId", userID), zap.Error(err))
			continue
		}
		revoked++
	}
	logger.Ctx(ctx).Info("other sessions ended", zap.Int64("userId", userID),
		zap.Int("revokedCount", revoked))
	return revoked, nil
}

// IssueRelayTicket 用浏览器登录会话换取只可连接 relay client 的短效票据。
//
// 票据记在短效凭据存储里，挂在签发它的这次会话名下：会话一结束，新连接的解析与已建连接的
// 复查都认不下它。取不到会话（sid 为空）就不发，否则就是一张登出撤不掉的票——票在手就能连
// /v1/relay/client 读写该账号全部机器上的会话。记不下来同样不发（fail-closed）。
func (s *authSvc) IssueRelayTicket(ctx context.Context, sid string, userID int64) (*RelayTicket, error) {
	token, err := s.credentials.IssueRelayClient(ctx, userID, sid)
	if err != nil {
		return nil, err
	}
	return &RelayTicket{
		Token: token, PeerFingerprint: credstore.AccountPeerFingerprint(userID), ExpiresIn: credstore.TTL,
	}, nil
}

// ResolveCredential 解析一张短效凭据的身份。有效 = 记录存在（未过期）且签发它的登录会话
// 仍在；server 自用凭据不挂会话。连过一次中继不影响解析：有效期内它可以被反复核验。
//
// 未知、过期、会话已结束一律 device_svc.ErrBearerInvalid；存储读不到判不出来，交
// ErrCredentialUnverifiable。凭据本身从不进日志。
func (s *authSvc) ResolveCredential(ctx context.Context, token string) (*device_svc.Principal, error) {
	cred, err := s.credentials.Resolve(ctx, token)
	if errors.Is(err, credstore.ErrNotFound) {
		return nil, device_svc.ErrBearerInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrCredentialUnverifiable, err)
	}
	if cred.SessionID != "" {
		alive, err := s.store.Exists(ctx, cred.SessionID)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrCredentialUnverifiable, err)
		}
		if !alive {
			return nil, device_svc.ErrBearerInvalid
		}
	}
	return &device_svc.Principal{
		AccountID:       cred.AccountID,
		Kind:            cred.Kind,
		PeerFingerprint: cred.PeerFingerprint,
		ExpiresAt:       cred.ExpiresAt,
		Handle:          cred.Handle,
	}, nil
}

// WatchRelayCredential 解析一条**已经建好**的中继票据连接背后的撤销判据，返回一个可被
// 连接心跳反复调用的判定函数。handle 是票据的句柄（中间件放行时交给下游的那一个）。
//
// 中继的两个 websocket 端点只在 upgrade 那一刻过一次鉴权中间件，之后不再经过任何
// 中间件；没有这个复查，登出就只挡得住新连接，一条登出前建好的连接会继续读写该账号名下
// 的全部会话。
//
// 这里只管中继票据（设备 access token 背后的连接由 connguard 按设备状态复查）。判据是
// 签发它的登录会话是否还在——撤销方（登出）本来就会删它，而它在共享 Redis 里，天然跨实例：
// 登出请求落在哪个副本上无关紧要。sid 逐浏览器互不相同，登出一个不会牵连同账号的其它浏览器。
//
// 归属会话只在这里解析一次、之后留在闭包里：票据记录只活 2 分钟，而连接活得比票久得多。
// upgrade 时就查不到记录的连接没有任何可复查的依据，按已撤销处理。
func (s *authSvc) WatchRelayCredential(ctx context.Context, handle string) RelayCredentialWatch {
	cred, err := s.credentials.Lookup(ctx, handle)
	switch {
	case errors.Is(err, credstore.ErrNotFound):
		return func(context.Context) bool { return true }
	case err != nil:
		logger.Ctx(ctx).Warn("auth_svc.WatchRelayCredential: 解析中继票据归属会话失败，"+
			"该连接登出时将撤不掉，只靠账号闸门复查", zap.Error(err))
		return func(context.Context) bool { return false }
	case cred.SessionID == "":
		return func(context.Context) bool { return false }
	}
	sid := cred.SessionID
	return func(ctx context.Context) bool {
		alive, err := s.store.Exists(ctx, sid)
		if err != nil {
			// 判不出来就不断开：撤销本身早已生效（session 已删、新连接已认不下这张票），
			// 这里只是收尾。一次 Redis 抖动把全部中继连接一起踢下线，比晚一个心跳才踢差得多。
			logger.Ctx(ctx).Warn("auth_svc.WatchRelayCredential: 判定登录会话存活失败，暂不断开中继连接",
				zap.Error(err))
			return false
		}
		return !alive
	}
}

func (s *authSvc) CookieName() string { return s.store.CookieName() }
