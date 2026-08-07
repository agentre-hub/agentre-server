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
	UID  int64    `json:"uid"`
	DID  int64    `json:"did"`
	Kind string   `json:"kind"`
	Caps []string `json:"caps"`
	JTI  string   `json:"-"`
}

type registered struct {
	UID  int64    `json:"uid"`
	DID  int64    `json:"did"`
	Kind string   `json:"kind"`
	Caps []string `json:"caps"`
	jwtv5.RegisteredClaims
}

// Signer 持有 RSA 密钥对 + 元信息。线程安全（crypto/rand.Reader 并发安全）。
type Signer struct {
	priv   *rsa.PrivateKey
	pub    *rsa.PublicKey
	issuer string
	aud    string
}

// NewSigner 从 PEM 解析公私钥。
func NewSigner(privPEM, pubPEM []byte, issuer, audience string) (*Signer, error) {
	priv, err := jwtv5.ParseRSAPrivateKeyFromPEM(privPEM)
	if err != nil {
		return nil, fmt.Errorf("parse private pem: %w", err)
	}
	pub, err := jwtv5.ParseRSAPublicKeyFromPEM(pubPEM)
	if err != nil {
		return nil, fmt.Errorf("parse public pem: %w", err)
	}
	return &Signer{
		priv:   priv,
		pub:    pub,
		issuer: issuer,
		aud:    audience,
	}, nil
}

const skew = 60 * time.Second

// Sign 返回 token 字符串 + jti（用于黑名单存储）。
func (s *Signer) Sign(c Claims, ttl time.Duration) (string, string, error) {
	now := time.Now()
	jti := ulid.MustNew(ulid.Timestamp(now), rand.Reader).String()
	reg := registered{
		UID: c.UID, DID: c.DID, Kind: c.Kind, Caps: c.Caps,
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
		return s.pub, nil
	}, jwtv5.WithLeeway(skew), jwtv5.WithIssuer(s.issuer), jwtv5.WithAudience(s.aud))
	if err != nil {
		return nil, err
	}
	reg, ok := parsed.Claims.(*registered)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return &Claims{
		UID: reg.UID, DID: reg.DID, Kind: reg.Kind, Caps: reg.Caps, JTI: reg.ID,
	}, nil
}
