package jwt_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	jwtv5 "github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	hubjwt "agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
)

func newSigner(t *testing.T) *hubjwt.Signer {
	s, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSignAndVerify_Roundtrip(t *testing.T) {
	s := newSigner(t)
	tok, jti, err := s.Sign(hubjwt.Claims{
		UID: 5678, DID: 1234, Kind: "agentred",
	}, time.Hour)
	assert.NoError(t, err)
	assert.NotEmpty(t, tok)
	assert.NotEmpty(t, jti)

	got, err := s.Verify(tok)
	assert.NoError(t, err)
	assert.Equal(t, int64(5678), got.UID)
	assert.Equal(t, int64(1234), got.DID)
	assert.Equal(t, "agentred", got.Kind)
	assert.Equal(t, jti, got.JTI)
}

func TestVerify_ExpiredToken(t *testing.T) {
	s := newSigner(t)
	tok, _, err := s.Sign(hubjwt.Claims{UID: 1, DID: 1}, -time.Minute)
	assert.NoError(t, err)
	_, err = s.Verify(tok)
	assert.Error(t, err)
}

func TestVerify_TamperedSignature(t *testing.T) {
	s := newSigner(t)
	tok, _, err := s.Sign(hubjwt.Claims{UID: 1, DID: 1}, time.Hour)
	assert.NoError(t, err)
	_, err = s.Verify(tok + "AAA")
	assert.Error(t, err)
}

func TestSign_ConcurrentCallsProducesUniqueJTI(t *testing.T) {
	s := newSigner(t)
	numGoroutines := 100
	results := make(chan string, numGoroutines)
	errs := make(chan error, numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		go func() {
			_, jti, err := s.Sign(hubjwt.Claims{
				UID: 5678, DID: 1234, Kind: "agentred",
			}, time.Hour)
			if err != nil {
				errs <- err
				return
			}
			results <- jti
		}()
	}

	jtis := make(map[string]bool)
	for i := 0; i < numGoroutines; i++ {
		select {
		case err := <-errs:
			t.Fatalf("Sign failed: %v", err)
		case jti := <-results:
			if jtis[jti] {
				t.Errorf("duplicate jti: %s", jti)
			}
			jtis[jti] = true
		}
	}

	assert.Equal(t, numGoroutines, len(jtis), "expected all jti values to be unique")
}

// TestVerify_LegacyTokenCarryingCapsClaim 锁住兼容承诺：能力概念移除之前签发的
// access token 里多带一个 caps 字段，在它自己的有效期内必须照常验签通过。这里的
// token 不能用 Sign 造——Claims 已经没有那个字段了——所以直接按旧形状手搓一枚。
func TestVerify_LegacyTokenCarryingCapsClaim(t *testing.T) {
	s := newSigner(t)
	priv, err := jwtv5.ParseRSAPrivateKeyFromPEM(testkeys.PrivatePEM)
	require.NoError(t, err)

	now := time.Now()
	legacy := jwtv5.MapClaims{
		"uid":  5678,
		"did":  1234,
		"kind": "agentred",
		"caps": []string{"compute", "file_browse"},
		"iss":  "agentre-server",
		"sub":  fmt.Sprintf("device:%d", 1234),
		"aud":  []string{"agentre"},
		"iat":  now.Unix(),
		"exp":  now.Add(time.Hour).Unix(),
		"jti":  "01LEGACYTOKENJTI0000000000",
	}
	tok, err := jwtv5.NewWithClaims(jwtv5.SigningMethodRS256, legacy).SignedString(priv)
	require.NoError(t, err)

	got, err := s.Verify(tok)
	require.NoError(t, err)
	assert.Equal(t, int64(5678), got.UID)
	assert.Equal(t, int64(1234), got.DID)
	assert.Equal(t, "agentred", got.Kind)
	assert.Equal(t, "01LEGACYTOKENJTI0000000000", got.JTI)
}

// TestSign_EmitsNoCapsClaim 断言：新签发的 token 载荷里不再有 caps 字段。能力概念
// 移除后它必须是真的不见了，而不是恒为 null——留一个空字段会让读 token 的人以为
// 存在一层能力边界。
func TestSign_EmitsNoCapsClaim(t *testing.T) {
	s := newSigner(t)
	tok, _, err := s.Sign(hubjwt.Claims{UID: 1, DID: 2, Kind: "desktop"}, time.Hour)
	require.NoError(t, err)

	parts := strings.Split(tok, ".")
	require.Len(t, parts, 3)
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	require.NoError(t, err)

	var claims map[string]any
	require.NoError(t, json.Unmarshal(payload, &claims))
	_, present := claims["caps"]
	assert.False(t, present, "signed payload must not carry a caps claim, got: %s", payload)
}
