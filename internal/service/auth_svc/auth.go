// Package auth_svc 维护浏览器 session 与 OAuth state。
package auth_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/cago-frame/cago/pkg/logger"
	goredis "github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
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
	// TrackRelayTicket 登记「这次会话签发了这张 relay ticket」，EndSession 据此把
	// 仍在有效期内的票拉黑。不登记的票登出后撤不掉，只能等自然过期。
	TrackRelayTicket(ctx context.Context, sid, jti string, ttl time.Duration) error
	// WatchRelayCredential 取一条**已经建好**的中继连接的撤销判定，见实现处说明。
	WatchRelayCredential(ctx context.Context, jti string) RelayCredentialWatch
	CookieName() string
}

// RelayCredentialWatch 是一条已经建好的中继连接的撤销判定：连接的心跳反复调用它，
// 返回 true 表示背后的凭据已被撤销、这条连接必须断开。
type RelayCredentialWatch func(ctx context.Context) bool

type authSvc struct {
	redis     *goredis.Client
	blacklist *jwtblacklist.Blacklist
	store     *session.Store
}

// New 接收这个 service 要用的 Redis 客户端，不去够 redis.Default()。
//
// 与 session.Store / passkey_svc / user_svc.Gate 同一形状：全局单例只在组合根
// （bootstrap.RegisterDefaults）出现一次，其余各层拿到的都是构造时注入的那一个。
func New(rc *goredis.Client, store *session.Store) AuthSvc {
	return &authSvc{redis: rc, blacklist: jwtblacklist.New(rc), store: store}
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

func (s *authSvc) EndSession(ctx context.Context, sid string) error {
	// 先撤票再删 session：反过来的话，中途失败会留下「会话已没了、票还能用」的
	// 状态，正是这里要根治的那段越权窗口。
	s.revokeRelayTickets(ctx, sid)
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
// 逐条走的顺序与 EndSession 完全一致（先撤票、再删 session），差别只在这里是尽力而为：
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
		s.revokeRelayTickets(ctx, info.SID)
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

// relayTicketKey 是「这次会话签发过哪些 relay ticket」的归集键。
//
// 按 sid 而不是 user_id 归集：登出只该作废这一个浏览器的票，同账号的其它浏览器
// 各自持有的票不受牵连。
func relayTicketKey(sid string) string { return "session_relay_ticket:" + sid }

// relayTicketSessionKey 是「这张票由哪次会话签发」的反向索引，由中继连接在
// upgrade 时读一次，用来把自己认到一次登录名下。
//
// 它与票同寿（几分钟）就够：票只在这段窗口里连得上，连上之后归属会话就留在连接
// 自己手里了。真正长命的是连接，不是这条索引。
func relayTicketSessionKey(jti string) string { return "relay_ticket_session:" + jti }

func (s *authSvc) TrackRelayTicket(ctx context.Context, sid, jti string, ttl time.Duration) error {
	if sid == "" || jti == "" {
		return errors.New("empty sid or jti")
	}
	// 成员里带上「最后一刻仍可验签的时间」：Verify 接受 jwt.Leeway 的时钟偏移，
	// 票直到 exp+Leeway 都还验得过。登出时按它算黑名单 TTL，正好盖满整个窗口，
	// 不会留下「已掉出黑名单、却仍验得过」的缝（device_svc.Revoke 同一套算法）。
	lifetime := ttl + jwt.Leeway
	member := strconv.FormatInt(time.Now().Add(lifetime).UnixMilli(), 10) + ":" + jti
	key := relayTicketKey(sid)
	if err := s.redis.SAdd(ctx, key, member).Err(); err != nil {
		return err
	}
	// 整个集合与最后签发的那张票同寿（票只有 2 分钟），到点自然回收：
	// 长命的浏览器 session 不会在 Redis 里堆一辈子的 jti。
	if err := s.redis.Expire(ctx, key, lifetime).Err(); err != nil {
		return err
	}
	// 反向索引同样 fail-closed：写不上就等于发一张「连上之后再也踢不掉」的票。
	return s.redis.Set(ctx, relayTicketSessionKey(jti), sid, lifetime).Err()
}

// WatchRelayCredential 解析一条**已经建好**的中继连接背后的撤销判据，返回一个可被
// 连接心跳反复调用的判定函数。
//
// 中继的两个 websocket 端点只在 upgrade 那一刻过一次鉴权中间件，之后不再经过任何
// 中间件；没有这个复查，登出与设备撤销就只挡得住新连接，一条撤销前建好的连接会继续
// 读写该账号名下的全部会话。
//
// 判据全部是**撤销方本来就会写**的共享 Redis 状态，因此天然跨实例：撤销请求落在哪个
// 副本上无关紧要，持有那条连接的副本自己读得到，不需要实例间寻址或广播。
//   - 设备撤销：device_svc.Revoke 把该设备已签发的 jti 全部拉黑。jti 逐设备互不相同，
//     撤一台不会牵连同账号的其它设备。
//   - 浏览器登出：EndSession 删掉 session。sid 逐浏览器互不相同，登出一个不会牵连
//     同账号的其它浏览器。
//
// 归属会话只在这里解析一次、之后留在闭包里：反向索引与票同寿，而连接活得比票久得多，
// 每次判定都去查索引的话，票一过期就再也认不出这条连接属于谁。
func (s *authSvc) WatchRelayCredential(ctx context.Context, jti string) RelayCredentialWatch {
	sid := ""
	if jti != "" {
		resolved, err := s.redis.Get(ctx, relayTicketSessionKey(jti)).Result()
		switch {
		case err == nil:
			sid = resolved
		case errors.Is(err, goredis.Nil):
			// 没有登记：原生端用的是设备 JWT（本来就没有归属会话），或票的登记已过期。
		default:
			logger.Ctx(ctx).Warn("auth_svc.WatchRelayCredential: 解析 relay ticket 归属会话失败，"+
				"该连接登出时将撤不掉，只能靠 jti 黑名单", zap.Error(err))
		}
	}
	return func(ctx context.Context) bool {
		if jti != "" && s.blacklist.Has(ctx, jti) {
			return true
		}
		if sid == "" {
			return false
		}
		alive, err := s.store.Exists(ctx, sid)
		if err != nil {
			// 判不出来就不断开（与 jwtblacklist.Has 同向 fail-open）：撤销本身早已生效
			// （session 已删、jti 已拉黑），这里只是收尾。一次 Redis 抖动把全部中继连接
			// 一起踢下线，比晚一个心跳才踢差得多。
			logger.Ctx(ctx).Warn("auth_svc.WatchRelayCredential: 判定登录会话存活失败，暂不断开中继连接",
				zap.Error(err))
			return false
		}
		return !alive
	}
}

// revokeRelayTickets 把这次会话签发、仍在有效期内的 relay ticket 全部拉黑，
// 让登出立刻切断 /v1/relay/client（middleware.RelayClientJWT 逐请求查黑名单）。
// EndSession 与 EndOtherSessions 共用它，两条路径因此撤得一样干净。
//
// 刻意不返回错误：用户点了登出就必须登出成功，不能因为黑名单写失败把登出也一起
// 拒掉——何况 session 本身就存在同一个 Redis 里，那种时候删 session 也会失败，
// 报错方向应由 store.Delete 决定。Redis 抖动时退化成「票最多再活 ttl」的原状，
// 不比现在更差，但要留 warn 日志，免得这段静默失败没人看见。
func (s *authSvc) revokeRelayTickets(ctx context.Context, sid string) {
	if sid == "" {
		return
	}
	key := relayTicketKey(sid)
	members, err := s.redis.SMembers(ctx, key).Result()
	if err != nil {
		logger.Ctx(ctx).Warn("auth_svc.revokeRelayTickets: 读取会话 relay ticket 失败，票据只能等自然过期",
			zap.Error(err))
		return
	}
	nowMs := time.Now().UnixMilli()
	for _, member := range members {
		deadlineMs, jti, ok := parseRelayTicketMember(member)
		if !ok {
			continue
		}
		// 已过窗口的票验签本来就过不了，再拉黑只是给 Redis 添垃圾。
		remainMs := deadlineMs - nowMs
		if remainMs <= 0 {
			continue
		}
		ttlSec := int((remainMs + 999) / 1000) // 向上取整，别让黑名单比票先过期
		if err := s.blacklist.Add(ctx, jti, ttlSec); err != nil {
			logger.Ctx(ctx).Warn("auth_svc.revokeRelayTickets: relay ticket 拉黑失败",
				zap.String("jti", jti), zap.Error(err))
		}
	}
	if err := s.redis.Del(ctx, key).Err(); err != nil {
		logger.Ctx(ctx).Warn("auth_svc.revokeRelayTickets: 清理会话 relay ticket 集合失败", zap.Error(err))
	}
}

// parseRelayTicketMember 拆 "<deadlineUnixMilli>:<jti>"。jti 是 ULID，不含冒号。
func parseRelayTicketMember(member string) (int64, string, bool) {
	deadline, jti, found := strings.Cut(member, ":")
	if !found || jti == "" {
		return 0, "", false
	}
	deadlineMs, err := strconv.ParseInt(deadline, 10, 64)
	if err != nil {
		return 0, "", false
	}
	return deadlineMs, jti, true
}

func (s *authSvc) CookieName() string { return s.store.CookieName() }
