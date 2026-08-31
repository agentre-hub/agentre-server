package jwt_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"strings"
	"testing"
	"time"

	jwtv5 "github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	hubjwt "github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
)

func TestKeyRing_GivenActiveAndRetiredKeys_WhenSigningAndVerifying_ThenUsesTokenKID(t *testing.T) {
	oldPrivate, oldPublic := rsaKeyPair(t)
	currentPrivate, currentPublic := rsaKeyPair(t)
	signer, err := hubjwt.NewKeyRing("current", []hubjwt.Key{
		{ID: "old", PublicPEM: oldPublic},
		{ID: "current", PrivatePEM: currentPrivate, PublicPEM: currentPublic},
	}, "agentre-server", "agentre", 15*time.Minute)
	require.NoError(t, err)

	token, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred"}, 15*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "current", tokenKID(t, token))
	_, err = signer.Verify(token)
	require.NoError(t, err)

	oldSigner, err := hubjwt.NewKeyRing("old", []hubjwt.Key{
		{ID: "old", PrivatePEM: oldPrivate, PublicPEM: oldPublic},
	}, "agentre-server", "agentre", 15*time.Minute)
	require.NoError(t, err)
	oldToken, _, err := oldSigner.Sign(hubjwt.Claims{UID: 7, DID: 42}, 15*time.Minute)
	require.NoError(t, err)
	_, err = signer.Verify(oldToken)
	require.NoError(t, err, "只验不签的旧 key 在正常轮换窗口内仍应接受")
}

func TestKeyRing_GivenOverlongOrEmergencyRetiredToken_WhenVerifying_ThenRejects(t *testing.T) {
	oldPrivate, oldPublic := rsaKeyPair(t)
	currentPrivate, currentPublic := rsaKeyPair(t)
	issuer := func(active string, keys []hubjwt.Key, maxLifetime time.Duration) *hubjwt.Signer {
		t.Helper()
		signer, err := hubjwt.NewKeyRing(active, keys, "agentre-server", "agentre", maxLifetime)
		require.NoError(t, err)
		return signer
	}

	oldSigner := issuer("old", []hubjwt.Key{{
		ID: "old", PrivatePEM: oldPrivate, PublicPEM: oldPublic,
	}}, time.Hour)
	overlong, _, err := oldSigner.Sign(hubjwt.Claims{UID: 7, DID: 42}, time.Hour)
	require.NoError(t, err)

	rotating := issuer("current", []hubjwt.Key{
		{ID: "old", PublicPEM: oldPublic},
		{ID: "current", PrivatePEM: currentPrivate, PublicPEM: currentPublic},
	}, 15*time.Minute)
	_, err = rotating.Verify(overlong)
	require.ErrorContains(t, err, "maximum lifetime")

	emergencyRetired := issuer("current", []hubjwt.Key{
		{ID: "current", PrivatePEM: currentPrivate, PublicPEM: currentPublic},
	}, 15*time.Minute)
	_, err = emergencyRetired.Verify(overlong)
	require.ErrorContains(t, err, "unknown or retired kid")
}

func rsaKeyPair(t *testing.T) ([]byte, []byte) {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateDER := x509.MarshalPKCS1PrivateKey(privateKey)
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	require.NoError(t, err)
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: privateDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})
}

func tokenKID(t *testing.T, token string) string {
	t.Helper()
	parts := strings.Split(token, ".")
	require.Len(t, parts, 3)
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	require.NoError(t, err)
	var header struct {
		KID string `json:"kid"`
	}
	require.NoError(t, json.Unmarshal(headerJSON, &header))
	return header.KID
}

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

func TestVerify_RejectsTokenWithoutKID(t *testing.T) {
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

	_, err = s.Verify(tok)
	require.ErrorContains(t, err, "unknown or retired kid")
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

// TestSignVerify_GivenPeerFingerprintClaim_ThenItSurvivesTheRoundTrip
// pfp 是凭据里说了算的对端身份（agentred 的 Mode C 握手从它取，不再看请求体）。
// 它必须原样签进去、原样验出来 —— 少一环，握手侧就只能退回去采信自报值。
func TestSignVerify_GivenPeerFingerprintClaim_ThenItSurvivesTheRoundTrip(t *testing.T) {
	signer, err := hubjwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)

	token, _, err := signer.Sign(hubjwt.Claims{UID: 7, DID: 42, Kind: "agentred", PFP: "sha256:device-42"}, time.Hour)
	require.NoError(t, err)
	claims, err := signer.Verify(token)

	require.NoError(t, err)
	assert.Equal(t, "sha256:device-42", claims.PFP)
}

// TestAccountPeerFingerprint_GivenTheSameAccount_ThenIsStableAndAccountScoped
// 决策 9：网页对端身份由账号派生 —— 同一账号在任意浏览器、清过站点数据之后拿到的
// 都是同一个值，不同账号之间不相等。它是「清一次缓存就换人」那条毛病的修法。
func TestAccountPeerFingerprint_GivenTheSameAccount_ThenIsStableAndAccountScoped(t *testing.T) {
	first := hubjwt.AccountPeerFingerprint(7)

	assert.Equal(t, first, hubjwt.AccountPeerFingerprint(7))
	assert.NotEqual(t, first, hubjwt.AccountPeerFingerprint(8))
	assert.True(t, strings.HasPrefix(first, "sha256:"), "与设备指纹同一形态，daemon 侧不必分两种解析")
}
