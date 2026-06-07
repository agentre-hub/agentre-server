//go:build test || jwttestkeys

package jwt_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

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
		UID: 5678, DID: 1234, Kind: "agentred", Caps: []string{"compute"},
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
