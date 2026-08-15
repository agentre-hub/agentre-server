package device_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/api"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/pkg/session"
	"agentre-server/internal/service/auth_svc"
)

func TestRelayTicket_FromSessionWithoutCreatingDevice(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}, Signer: signer}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	cookie, csrf := newSessionCookie(t, 7)
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/relay/ticket", cookie.Value, "", `{}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			AccessToken string `json:"access_token"`
			ExpiresIn   int    `json:"expires_in"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	claims, err := signer.Verify(envelope.Data.AccessToken)
	require.NoError(t, err)
	require.Equal(t, int64(7), claims.UID)
	require.Zero(t, claims.DID)
	require.Equal(t, "relay_client", claims.Kind)
	require.Equal(t, 120, envelope.Data.ExpiresIn)
}
