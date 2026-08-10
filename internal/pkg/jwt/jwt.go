// Package jwt 封装 RS256 access token 的签发与校验。
package jwt

import (
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"fmt"
	"time"

	jwtv5 "github.com/golang-jwt/jwt/v5"
	"github.com/oklog/ulid/v2"
)

// Claims 是 access token 内嵌的业务字段。
type Claims struct {
	UID  int64  `json:"uid"`
	DID  int64  `json:"did"`
	Kind string `json:"kind"`
	JTI  string `json:"-"`
}

type registered struct {
	UID  int64  `json:"uid"`
	DID  int64  `json:"did"`
	Kind string `json:"kind"`
	jwtv5.RegisteredClaims
}

// Signer 持有 RSA 密钥对 + 元信息。线程安全（crypto/rand.Reader 并发安全）。
type Signer struct {
	activeKID   string
	priv        *rsa.PrivateKey
	publicKeys  map[string]*rsa.PublicKey
	issuer      string
	aud         string
	maxLifetime time.Duration
	allowNoKID  bool
}

// Key 是一把 JWT RSA 密钥。当前签发 key 同时提供私钥和公钥；轮换窗口内只用于
// 验签的旧 key 只需提供公钥。
type Key struct {
	ID         string
	PrivatePEM []byte
	PublicPEM  []byte
}

const legacyKID = "legacy"

// NewSigner 从 PEM 解析公私钥。
func NewSigner(privPEM, pubPEM []byte, issuer, audience string) (*Signer, error) {
	return NewSignerWithMaxLifetime(privPEM, pubPEM, issuer, audience, 0)
}

// NewSignerWithMaxLifetime 保留单 key 配置的迁移兼容：新 token 带 legacy kid，
// 部署升级前签发、没有 kid 的旧 token 在其剩余短有效期内仍可验签。
func NewSignerWithMaxLifetime(privPEM, pubPEM []byte, issuer, audience string,
	maxLifetime time.Duration) (*Signer, error) {
	signer, err := NewKeyRing(legacyKID, []Key{{
		ID: legacyKID, PrivatePEM: privPEM, PublicPEM: pubPEM,
	}}, issuer, audience, maxLifetime)
	if err != nil {
		return nil, err
	}
	signer.allowNoKID = true
	return signer, nil
}

// NewKeyRing 构造支持轮换的签发/验签器。activeKID 对应的 key 必须包含私钥；
// 其他 key 可以只包含公钥。maxLifetime 为零时不额外限制 token 生命周期。
func NewKeyRing(activeKID string, keys []Key, issuer, audience string, maxLifetime time.Duration) (*Signer, error) {
	if activeKID == "" {
		return nil, errors.New("missing active kid")
	}
	publicKeys := make(map[string]*rsa.PublicKey, len(keys))
	var activePrivate *rsa.PrivateKey
	for _, key := range keys {
		if key.ID == "" {
			return nil, errors.New("empty kid")
		}
		if _, exists := publicKeys[key.ID]; exists {
			return nil, fmt.Errorf("duplicate kid %q", key.ID)
		}
		pub, err := jwtv5.ParseRSAPublicKeyFromPEM(key.PublicPEM)
		if err != nil {
			return nil, fmt.Errorf("parse public pem for kid %q: %w", key.ID, err)
		}
		publicKeys[key.ID] = pub
		if key.ID == activeKID {
			priv, err := jwtv5.ParseRSAPrivateKeyFromPEM(key.PrivatePEM)
			if err != nil {
				return nil, fmt.Errorf("parse private pem for active kid %q: %w", key.ID, err)
			}
			activePrivate = priv
		}
	}
	if activePrivate == nil {
		return nil, fmt.Errorf("active kid %q not found", activeKID)
	}
	return &Signer{activeKID: activeKID, priv: activePrivate, publicKeys: publicKeys,
		issuer: issuer, aud: audience, maxLifetime: maxLifetime}, nil
}

// Leeway 是 Verify 接受的时钟偏移:一个 access token 直到 exp+Leeway 之前都还会
// 验签通过。任何「让已签发凭据失效」的机制(黑名单 TTL、吊销列表窗口)都必须覆盖
// 到 exp+Leeway,否则会留下一段 token 已不在吊销面、却仍被接受的空窗。
const Leeway = 60 * time.Second

// Sign 返回 token 字符串 + jti（用于黑名单存储）。
func (s *Signer) Sign(c Claims, ttl time.Duration) (string, string, error) {
	if s.maxLifetime > 0 && ttl > s.maxLifetime {
		return "", "", errors.New("token exceeds maximum lifetime")
	}
	now := time.Now()
	jti := ulid.MustNew(ulid.Timestamp(now), rand.Reader).String()
	reg := registered{
		UID: c.UID, DID: c.DID, Kind: c.Kind,
		RegisteredClaims: jwtv5.RegisteredClaims{
			Issuer:    s.issuer,
			Subject:   fmt.Sprintf("device:%d", c.DID),
			Audience:  []string{s.aud},
			IssuedAt:  jwtv5.NewNumericDate(now),
			ExpiresAt: jwtv5.NewNumericDate(now.Add(ttl)),
			ID:        jti,
		},
	}
	t := jwtv5.NewWithClaims(jwtv5.SigningMethodRS256, reg)
	t.Header["kid"] = s.activeKID
	out, err := t.SignedString(s.priv)
	if err != nil {
		return "", "", err
	}
	return out, jti, nil
}

// Verify 校验签名 + iss/aud + exp（±60s skew）。
func (s *Signer) Verify(token string) (*Claims, error) {
	parsed, err := jwtv5.ParseWithClaims(token, &registered{}, func(t *jwtv5.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwtv5.SigningMethodRSA); !ok {
			return nil, errors.New("unexpected signing method")
		}
		kid, _ := t.Header["kid"].(string)
		if kid == "" && s.allowNoKID {
			kid = s.activeKID
		}
		pub, ok := s.publicKeys[kid]
		if !ok {
			return nil, errors.New("unknown or retired kid")
		}
		return pub, nil
	}, jwtv5.WithLeeway(Leeway), jwtv5.WithIssuer(s.issuer), jwtv5.WithAudience(s.aud))
	if err != nil {
		return nil, err
	}
	reg, ok := parsed.Claims.(*registered)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	if s.maxLifetime > 0 {
		if reg.IssuedAt == nil || reg.ExpiresAt == nil {
			return nil, errors.New("token missing iat or exp")
		}
		if reg.ExpiresAt.Sub(reg.IssuedAt.Time) > s.maxLifetime {
			return nil, errors.New("token exceeds maximum lifetime")
		}
	}
	return &Claims{
		UID: reg.UID, DID: reg.DID, Kind: reg.Kind, JTI: reg.ID,
	}, nil
}
