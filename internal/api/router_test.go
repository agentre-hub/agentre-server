package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/bootstrap"
)

func servePublicKeys(t *testing.T, cfg bootstrap.JWTConfig) struct {
	Version                 int               `json:"version"`
	CurrentKID              string            `json:"current_kid"`
	Keys                    map[string]string `json:"keys"`
	PublicKey               string            `json:"public_key"`
	MaxTokenLifetimeSeconds int64             `json:"max_token_lifetime_seconds"`
} {
	t.Helper()
	testMux := muxtest.NewTestMux()
	deps := &RouterDeps{Cfg: &bootstrap.ServerConfig{JWT: cfg}}
	require.NoError(t, deps.Router(context.Background(), testMux.Router))

	request := httptest.NewRequest(http.MethodGet, "/v1/keys", nil)
	recorder := httptest.NewRecorder()
	testMux.IRouter.(*gin.Engine).ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var response struct {
		Version                 int               `json:"version"`
		CurrentKID              string            `json:"current_kid"`
		Keys                    map[string]string `json:"keys"`
		PublicKey               string            `json:"public_key"`
		MaxTokenLifetimeSeconds int64             `json:"max_token_lifetime_seconds"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	return response
}

// R3：daemon 在 login 时从 /v1/keys 取验签公钥并缓存，此后离线验签。签名者和
// 分发端点必须读取 public_key_pem_path 指向的同一份公钥，否则 agentred login
// 会直接失败，账号握手（R2）在真实部署里根本起不来。
func TestRouter_PublicKeyServesTheKeyConfiguredByPath(t *testing.T) {
	const pem = "-----BEGIN PUBLIC KEY-----\nfrom-file\n-----END PUBLIC KEY-----\n"
	path := filepath.Join(t.TempDir(), "jwt.pub")
	require.NoError(t, os.WriteFile(path, []byte(pem), 0o600))

	require.Equal(t, pem, servePublicKeys(t, bootstrap.JWTConfig{PublicKeyPEMPath: path}).PublicKey)
}

func TestRouter_PublicKeysGivenRotationWindowThenServesActiveVerificationSet(t *testing.T) {
	currentPath := filepath.Join(t.TempDir(), "current.pub")
	oldPath := filepath.Join(t.TempDir(), "old.pub")
	require.NoError(t, os.WriteFile(currentPath, []byte("current-pem"), 0o600))
	require.NoError(t, os.WriteFile(oldPath, []byte("old-pem"), 0o600))

	got := servePublicKeys(t, bootstrap.JWTConfig{
		ActiveKID: "current",
		AccessTTL: 15 * time.Minute,
		Keys: []bootstrap.JWTKeyConfig{
			{KID: "old", PublicKeyPEMPath: oldPath},
			{KID: "current", PublicKeyPEMPath: currentPath},
		},
	})

	require.Equal(t, 1, got.Version)
	require.Equal(t, "current", got.CurrentKID)
	require.Equal(t, "current-pem", got.PublicKey, "旧客户端字段指向当前签发 key")
	require.Equal(t, map[string]string{"old": "old-pem", "current": "current-pem"}, got.Keys)
	require.Equal(t, int64(900), got.MaxTokenLifetimeSeconds)
}
