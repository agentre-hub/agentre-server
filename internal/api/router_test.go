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

	"github.com/agentre-hub/agentre-server/internal/bootstrap"
)

func servePublicKeys(t *testing.T, cfg bootstrap.JWTConfig) struct {
	Version                 int               `json:"version"`
	CurrentKID              string            `json:"current_kid"`
	Keys                    map[string]string `json:"keys"`
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
		MaxTokenLifetimeSeconds int64             `json:"max_token_lifetime_seconds"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	return response
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
	require.Equal(t, map[string]string{"old": "old-pem", "current": "current-pem"}, got.Keys)
	require.Equal(t, int64(900), got.MaxTokenLifetimeSeconds)
}

func TestRouter_PublicKeysDoesNotExposeSingleKeyCompatibilityField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "current.pub")
	require.NoError(t, os.WriteFile(path, []byte("current-pem"), 0o600))
	testMux := muxtest.NewTestMux()
	deps := &RouterDeps{Cfg: &bootstrap.ServerConfig{JWT: bootstrap.JWTConfig{
		ActiveKID: "current",
		Keys:      []bootstrap.JWTKeyConfig{{KID: "current", PublicKeyPEMPath: path}},
	}}}
	require.NoError(t, deps.Router(context.Background(), testMux.Router))
	recorder := httptest.NewRecorder()
	testMux.IRouter.(*gin.Engine).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/keys", nil))
	var response map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	require.NotContains(t, response, "public_key")
}
