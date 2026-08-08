// Package session 提供 Redis-backed 浏览器 session 存储 + cookie 编码。
//
// 数据结构：session:<sid> -> JSON{user_id, csrf_token, created_at}
// TTL：14 天滑动；每次 Get 调用 EXPIRE 重置。
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// Session 是 Redis 中的 session payload。
type Session struct {
	UserID    int64  `json:"user_id"`
	CSRFToken string `json:"csrf_token"`
	CreatedAt int64  `json:"created_at"`
}

// Store 封装 Redis session 读写。
type Store struct {
	rc         *goredis.Client
	cookieName string
	ttl        time.Duration
}

// New 构造 store。ttlSeconds 是 session 滑动 TTL 秒数。
func New(rc *goredis.Client, cookieName string, ttlSeconds int) *Store {
	return &Store{rc: rc, cookieName: cookieName, ttl: time.Duration(ttlSeconds) * time.Second}
}

// CookieName 返回配置的 cookie 名。
func (s *Store) CookieName() string { return s.cookieName }

// Create 新建 session，返回 sid 与 session payload。
func (s *Store) Create(ctx context.Context, userID int64) (string, *Session, error) {
	sid, err := randomToken(32)
	if err != nil {
		return "", nil, err
	}
	csrf, err := randomToken(24)
	if err != nil {
		return "", nil, err
	}
	sess := &Session{
		UserID:    userID,
		CSRFToken: csrf,
		CreatedAt: time.Now().UnixMilli(),
	}
	body, _ := json.Marshal(sess)
	if err := s.rc.Set(ctx, "session:"+sid, body, s.ttl).Err(); err != nil {
		return "", nil, err
	}
	return sid, sess, nil
}

// Get 取 session，命中则刷新 TTL；未命中返 (nil, nil)。
func (s *Store) Get(ctx context.Context, sid string) (*Session, error) {
	if sid == "" {
		return nil, nil
	}
	val, err := s.rc.Get(ctx, "session:"+sid).Bytes()
	if errors.Is(err, goredis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var sess Session
	if err := json.Unmarshal(val, &sess); err != nil {
		return nil, err
	}
	// 滑动 TTL
	_ = s.rc.Expire(ctx, "session:"+sid, s.ttl).Err()
	return &sess, nil
}

// Delete 删除 session。
func (s *Store) Delete(ctx context.Context, sid string) error {
	if sid == "" {
		return nil
	}
	return s.rc.Del(ctx, "session:"+sid).Err()
}

func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
