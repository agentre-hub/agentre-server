package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/bootstrap"
)

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
