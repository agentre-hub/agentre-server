// Package credstore 保存 server 签发的短效不透明凭据：浏览器用登录会话换的中继票据，
// 以及 server 自己连机器用的镜像 / 端口转发凭据。
//
// 凭据是一串不带任何可解析内容的随机串，身份（账号、类型、对端指纹）全部由这里记在
// Redis 里、只按凭据的 sha256 摘要存取，明文不落盘。它住在 internal/pkg 而不是某个
// service：签发方有 auth_svc（票据）与 mirror_svc（自用凭据），读取方有鉴权中间件，
// 放进任何一方都会让另一方反向依赖它。
package credstore

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// TTL 是每一张短效凭据的有效期，也是它在 Redis 里的全部寿命。
const TTL = 2 * time.Minute

// 凭据类型。类型由签发入口决定，调用方选不了：浏览器只能换到 relay_client，
// server 自用的只能是 server_mirror，两者因此冒充不了对方的入口。
const (
	KindRelayClient  = "relay_client"
	KindServerMirror = "server_mirror"
)

const (
	recordKeyPrefix  = "credential:"
	connectKeyPrefix = "credential_relay_connected:"
	tokenBytes       = 32
)

// ErrNotFound 表示凭据未签发过或已过期。两种情形刻意不区分。
var ErrNotFound = errors.New("credential not found")

// Credential 是一张凭据背后由 server 记下的身份。
type Credential struct {
	AccountID       int64  `json:"account_id"`
	Kind            string `json:"kind"`
	PeerFingerprint string `json:"pfp"`
	// SessionID 是签发这张票据的浏览器登录会话；server 自用凭据为空。
	SessionID string `json:"sid,omitempty"`
	// ExpiresAt 是凭据失效的时刻（unix 毫秒）。
	ExpiresAt int64 `json:"expires_at"`
	// Handle 是凭据的摘要：可以交给长连接复查、可以记日志，从它推不回凭据本身。
	Handle string `json:"-"`
}

// Store 用构造时交给它的那台 Redis：「记录存在哪」只由组合根回答一次。
type Store struct {
	redis *goredis.Client
}

func New(rc *goredis.Client) *Store { return &Store{redis: rc} }

// IssueRelayClient 为一次浏览器登录会话签发中继票据，对端指纹由账号派生（决策 9）。
// 没有会话的票登出撤不掉，因此不发。
func (s *Store) IssueRelayClient(ctx context.Context, accountID int64, sessionID string) (string, error) {
	if accountID <= 0 || sessionID == "" {
		return "", errors.New("credstore: relay ticket needs an account and a session")
	}
	return s.issue(ctx, Credential{
		AccountID: accountID, Kind: KindRelayClient,
		PeerFingerprint: AccountPeerFingerprint(accountID), SessionID: sessionID,
	})
}

// IssueServerMirror 为 server 自己连向某账号机器的一条连接签发凭据，对端指纹是本副本的
// 合成身份，由调用方给出。
func (s *Store) IssueServerMirror(ctx context.Context, accountID int64, peerFingerprint string) (string, error) {
	if accountID <= 0 || peerFingerprint == "" {
		return "", errors.New("credstore: server credential needs an account and a peer fingerprint")
	}
	return s.issue(ctx, Credential{AccountID: accountID, Kind: KindServerMirror, PeerFingerprint: peerFingerprint})
}

func (s *Store) issue(ctx context.Context, c Credential) (string, error) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := strings.ToLower(strings.TrimRight(base32.StdEncoding.EncodeToString(buf), "="))
	c.ExpiresAt = time.Now().Add(TTL).UnixMilli()
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	if err := s.redis.Set(ctx, recordKeyPrefix+digest(token), body, TTL).Err(); err != nil {
		return "", fmt.Errorf("credstore: record credential: %w", err)
	}
	return token, nil
}

// Resolve 按凭据解析它的记录。有效期内可以反复解析，连过中继也不影响。
// Redis 不可用时返回的错误不是 ErrNotFound，由调用方 fail-closed。
func (s *Store) Resolve(ctx context.Context, token string) (*Credential, error) {
	if token == "" {
		return nil, ErrNotFound
	}
	return s.Lookup(ctx, digest(token))
}

// Lookup 按句柄取凭据记录，供已经建好的长连接复查自己背后的那张凭据。
func (s *Store) Lookup(ctx context.Context, handle string) (*Credential, error) {
	if handle == "" {
		return nil, ErrNotFound
	}
	body, err := s.redis.Get(ctx, recordKeyPrefix+handle).Bytes()
	if errors.Is(err, goredis.Nil) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("credstore: read credential: %w", err)
	}
	var c Credential
	if err := json.Unmarshal(body, &c); err != nil {
		return nil, fmt.Errorf("credstore: decode credential: %w", err)
	}
	c.Handle = handle
	return &c, nil
}

// ClaimRelayConnect 认领「用这张凭据连一次中继」，交回这一次是不是第一次。
//
// 票据经 websocket 子协议传输，可能落进反代日志；一张票只换得到一条连接，日志里那份
// 就是废票。记号与凭据同寿。Redis 不可用时报错，由调用方拒绝（fail-closed）。
func (s *Store) ClaimRelayConnect(ctx context.Context, handle string) (bool, error) {
	if handle == "" {
		return false, errors.New("credstore: empty credential handle")
	}
	return s.redis.SetNX(ctx, connectKeyPrefix+handle, "1", TTL).Result()
}

func digest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
