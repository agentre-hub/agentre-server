package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/bootstrap"
)

func servePublicKey(t *testing.T, cfg bootstrap.JWTConfig) string {
	t.Helper()
	testMux := muxtest.NewTestMux()
	deps := &RouterDeps{Cfg: &bootstrap.ServerConfig{JWT: cfg}}
	require.NoError(t, deps.Router(context.Background(), testMux.Router))

	request := httptest.NewRequest(http.MethodGet, "/v1/keys", nil)
	recorder := httptest.NewRecorder()
	testMux.IRouter.(*gin.Engine).ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var response struct {
		PublicKey string `json:"public_key"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	return response.PublicKey
}

// R3：daemon 在 login 时从 /v1/keys 取验签公钥并缓存，此后离线验签。签名者用
// loadPEM 解析「内联 或 路径」两种配置，而 configs/config.example.yaml 只给了
// public_key_pem_path —— 分发端点必须解析同一份，否则按文档部署的 server 分发出
// 空串，agentred login 直接失败，账号握手（R2）在真实部署里根本起不来。
func TestRouter_PublicKeyServesTheKeyConfiguredByPath(t *testing.T) {
	const pem = "-----BEGIN PUBLIC KEY-----\nfrom-file\n-----END PUBLIC KEY-----\n"
	path := filepath.Join(t.TempDir(), "jwt.pub")
	require.NoError(t, os.WriteFile(path, []byte(pem), 0o600))

	require.Equal(t, pem, servePublicKey(t, bootstrap.JWTConfig{PublicKeyPEMPath: path}))
}

// 两种配置都给时以内联值为准——与 LoadJWTSigner 的 loadPEM 同一优先级。
func TestRouter_PublicKeyPrefersInlinePEMOverPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "jwt.pub")
	require.NoError(t, os.WriteFile(path, []byte("from-file"), 0o600))

	require.Equal(t, "inline", servePublicKey(t, bootstrap.JWTConfig{
		PublicKeyPEM: "inline", PublicKeyPEMPath: path,
	}))
}

func TestRouter_PublicKeyReturnsConfiguredPEM(t *testing.T) {
	testMux := muxtest.NewTestMux()
	deps := &RouterDeps{Cfg: &bootstrap.ServerConfig{
		JWT: bootstrap.JWTConfig{PublicKeyPEM: "configured RS256 public PEM"},
	}}
	require.NoError(t, deps.Router(context.Background(), testMux.Router))

	request := httptest.NewRequest(http.MethodGet, "/v1/keys", nil)
	recorder := httptest.NewRecorder()
	testMux.IRouter.(*gin.Engine).ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var response struct {
		PublicKey string `json:"public_key"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.Equal(t, "configured RS256 public PEM", response.PublicKey)
}
