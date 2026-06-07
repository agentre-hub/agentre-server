// Package auth_svc 维护浏览器 session 与 OAuth state。
package auth_svc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/cago-frame/cago/database/redis"
	goredis "github.com/redis/go-redis/v9"

	"agentre-server/internal/pkg/session"
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

	StartSession(ctx context.Context, userID int64) (sid string, sess *session.Session, err error)
	GetSession(ctx context.Context, sid string) (*session.Session, error)
	EndSession(ctx context.Context, sid string) error
	CookieName() string
}

type authSvc struct {
	store *session.Store
}

func New(store *session.Store) AuthSvc {
	return &authSvc{store: store}
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
	if err := redis.Default().Set(ctx, "oauth_state:"+state, body, oauthStateTTL).Err(); err != nil {
		return "", err
	}
	return state, nil
}

func (s *authSvc) ConsumeOAuthState(ctx context.Context, state string) (*OAuthStatePayload, error) {
	if state == "" {
		return nil, nil
	}
	key := "oauth_state:" + state
	val, err := redis.Default().Get(ctx, key).Bytes()
	if errors.Is(err, goredis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = redis.Default().Del(ctx, key).Err()
	var p OAuthStatePayload
	if err := json.Unmarshal(val, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *authSvc) StartSession(ctx context.Context, userID int64) (string, *session.Session, error) {
	return s.store.Create(ctx, userID)
}

func (s *authSvc) GetSession(ctx context.Context, sid string) (*session.Session, error) {
	return s.store.Get(ctx, sid)
}

func (s *authSvc) EndSession(ctx context.Context, sid string) error {
	return s.store.Delete(ctx, sid)
}

func (s *authSvc) CookieName() string { return s.store.CookieName() }
