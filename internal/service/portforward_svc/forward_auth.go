package portforward_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// 转发登录（规格 2026-09-21-port-forward-subdomain「转发登录」、决策 6）：控制台签发
// 一枚一次性授权码，转发域拿它换出一张只对**这一个前缀**有效的转发会话，而转发会话
// **依附**签发它的那条控制台会话。
//
// Redis 结构：
//
//	pf_code:<code>     -> JSON{userId, prefix, consoleSid}   60 秒，GETDEL 取出即作废
//	pf_session:<token> -> JSON{userId, prefix, consoleSid}   固定 TTL，不滑动

// codeTTL 是授权码的寿命（规格：60 秒，只能用一次）。
const codeTTL = 60 * time.Second

// ErrCodeInvalid 是「这枚授权码换不出转发会话」：没有、过期、用过、或者签给的是另一个
// 前缀。四种对用户是同一件事——回控制台重新打开——所以不分开。
var ErrCodeInvalid = errors.New("port forward: authorization code invalid")

// ConsoleSessions 是「这条控制台会话还在不在」这一件事（ISP），实现是 *session.Store。
//
// 用 Exists 而不是 Get：转发请求一页就是几十上百个子资源，Get 每次都会滑动控制台会话
// 的 TTL 并写回 Redis——与中继连接的撤销判定（auth_svc.WatchRelayCredential）同一条
// 道理，判「还活着吗」不该顺手给它续命。
type ConsoleSessions interface {
	Exists(ctx context.Context, sid string) (bool, error)
}

// ForwardSession 是一张转发票代表的东西：哪个账号、只对哪个前缀、依附哪条控制台会话。
type ForwardSession struct {
	UserID     int64  `json:"userId"`
	Prefix     string `json:"prefix"`
	ConsoleSID string `json:"consoleSid"`
}

// ForwardAuth 管授权码与转发会话。
type ForwardAuth struct {
	rc         *goredis.Client
	sessions   ConsoleSessions
	sessionTTL time.Duration
}

// NewForwardAuth 构造。sessionTTL 是转发会话的寿命上限——它每次使用都还要过「控制台
// 会话还在」这一关，所以这个值只是兜底，取控制台会话的 TTL 即可。
func NewForwardAuth(rc *goredis.Client, sessions ConsoleSessions, sessionTTL time.Duration) *ForwardAuth {
	return &ForwardAuth{rc: rc, sessions: sessions, sessionTTL: sessionTTL}
}

var defaultForwardAuth *ForwardAuth

// DefaultForwardAuth 返回本进程那份；未装配时为 nil，调用方须自己判空。
func DefaultForwardAuth() *ForwardAuth     { return defaultForwardAuth }
func SetDefaultForwardAuth(a *ForwardAuth) { defaultForwardAuth = a }

func codeKey(code string) string     { return "pf_code:" + code }
func sessionKey(token string) string { return "pf_session:" + token }

// IssueCode 为 (账号, 前缀, 控制台会话) 签发一枚一次性授权码。前缀归不归这个账号由
// 调用方先判过。
func (a *ForwardAuth) IssueCode(ctx context.Context, userID int64, prefix, consoleSID string) (string, error) {
	code, err := randomToken()
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(ForwardSession{UserID: userID, Prefix: prefix, ConsoleSID: consoleSID})
	if err := a.rc.Set(ctx, codeKey(code), body, codeTTL).Err(); err != nil {
		return "", err
	}
	return code, nil
}

// Redeem 用授权码换一张转发票。码当场作废（GETDEL），包括前缀对不上的那一次：否则
// 一枚码能被拿去各个前缀上挨个试。
func (a *ForwardAuth) Redeem(ctx context.Context, code, prefix string) (string, error) {
	if code == "" {
		return "", ErrCodeInvalid
	}
	body, err := a.rc.GetDel(ctx, codeKey(code)).Bytes()
	if errors.Is(err, goredis.Nil) {
		return "", ErrCodeInvalid
	}
	if err != nil {
		return "", err
	}
	var fs ForwardSession
	if err := json.Unmarshal(body, &fs); err != nil || fs.Prefix != prefix {
		return "", ErrCodeInvalid
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := a.rc.Set(ctx, sessionKey(token), body, a.sessionTTL).Err(); err != nil {
		return "", err
	}
	return token, nil
}

// Resolve 按转发票取转发会话。票不存在、签给的是别的前缀、或它依附的控制台会话已经
// 不在时返回 (nil, nil)——三者都等于「没登录」，按转发登录第 1 步重走。
func (a *ForwardAuth) Resolve(ctx context.Context, token, prefix string) (*ForwardSession, error) {
	if token == "" {
		return nil, nil
	}
	body, err := a.rc.Get(ctx, sessionKey(token)).Bytes()
	if errors.Is(err, goredis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var fs ForwardSession
	if err := json.Unmarshal(body, &fs); err != nil || fs.Prefix != prefix {
		return nil, nil
	}
	alive, err := a.sessions.Exists(ctx, fs.ConsoleSID)
	if err != nil {
		return nil, err
	}
	if !alive {
		// 控制台会话没了，这张票从此再也用不上：顺手删掉，删不掉也无妨——下一次
		// 照样过不了上面这一关。
		_ = a.rc.Del(ctx, sessionKey(token)).Err()
		return nil, nil
	}
	return &fs, nil
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
