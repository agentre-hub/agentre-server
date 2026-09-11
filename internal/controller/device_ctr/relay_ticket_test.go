package device_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
)

func TestRelayTicket_FromSessionWithoutCreatingDevice(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))
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

// TestRelayTicket_GivenTheSameAccountOnAnotherBrowser_ThenCarriesTheSamePeerFingerprint
// 决策 8/9：网页对端身份写在票里，由账号派生。同一账号换一个会话（等价于清空站点
// 数据、换一台设备重新登录）取票，拿到的必须是同一个 pfp —— 否则此前从网页发起的
// 对话在账号镜像里当场没了身份键的一半。它同时必须原样交给浏览器：浏览器要拿它当
// 自己的对端指纹，而不是自己再生成一个。
func TestRelayTicket_GivenTheSameAccountOnAnotherBrowser_ThenCarriesTheSamePeerFingerprint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}, Signer: signer}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	ticket := func(t *testing.T) (string, string) {
		t.Helper()
		cookie, csrf := newSessionCookie(t, 7)
		resp := doRequest(t, http.MethodPost, server.URL+"/v1/relay/ticket", cookie.Value, "", `{}`, csrf)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var envelope struct {
			Data struct {
				AccessToken     string `json:"access_token"`
				PeerFingerprint string `json:"peer_fingerprint"`
			} `json:"data"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
		return envelope.Data.AccessToken, envelope.Data.PeerFingerprint
	}

	firstToken, firstPFP := ticket(t)
	secondToken, secondPFP := ticket(t)

	firstClaims, err := signer.Verify(firstToken)
	require.NoError(t, err)
	secondClaims, err := signer.Verify(secondToken)
	require.NoError(t, err)
	require.Equal(t, jwt.AccountPeerFingerprint(7), firstClaims.PFP)
	require.Equal(t, firstClaims.PFP, secondClaims.PFP)
	// 浏览器拿到的对端指纹就是票里那个身份，两者不能各说各的。字段名也必须是
	// peer_fingerprint：同一个值在 /v1/agent-sessions、/v1/session-import 和
	// dispatch 的上行里一律叫这个名字；不能叫 client_id——client_id
	// 在同一个服务的 /v1/oauth/* 底下是 RFC 6749 的注册客户端，不是指纹。
	require.Equal(t, firstClaims.PFP, firstPFP)
	require.Equal(t, firstPFP, secondPFP)
	require.Zero(t, firstClaims.DID, "网页仍然不是设备")
}
