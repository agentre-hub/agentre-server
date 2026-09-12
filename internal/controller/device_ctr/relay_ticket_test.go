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
	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
)

func TestRelayTicket_FromSessionWithoutCreatingDevice(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}}).Router(context.Background(), testMux.Router))
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
	p, err := auth_svc.Default().ResolveCredential(context.Background(), envelope.Data.AccessToken)
	require.NoError(t, err, "票据的身份由 server 记着，核验得到")
	require.Equal(t, int64(7), p.AccountID)
	require.Zero(t, p.DeviceID)
	require.Equal(t, credstore.KindRelayClient, p.Kind)
	require.Equal(t, 120, envelope.Data.ExpiresIn)
}

// S1：票据是 server 记录的随机串，不带任何可解析的内容——没有分段、没有可解码的载荷。
func TestRelayTicket_IsAnOpaqueRandomString(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	cookie, csrf := newSessionCookie(t, 7)
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/relay/ticket", cookie.Value, "", `{}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data struct {
			AccessToken string `json:"access_token"`
			ExpiresIn   int    `json:"expires_in"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.NotContains(t, envelope.Data.AccessToken, ".", "票据不能是 JWT 那种可解析的分段结构")
	require.GreaterOrEqual(t, len(envelope.Data.AccessToken), 43, "随机串要有足够的熵")
	require.Equal(t, 120, envelope.Data.ExpiresIn)
}

// TestRelayTicket_GivenTheSameAccountOnAnotherBrowser_ThenCarriesTheSamePeerFingerprint
// 决策 8/9：网页对端身份记在票据背后，由账号派生。同一账号换一个会话（等价于清空站点
// 数据、换一台设备重新登录）取票，拿到的必须是同一个 pfp —— 否则此前从网页发起的
// 对话在账号镜像里当场没了身份键的一半。它同时必须原样交给浏览器：浏览器要拿它当
// 自己的对端指纹，而不是自己再生成一个。
func TestRelayTicket_GivenTheSameAccountOnAnotherBrowser_ThenCarriesTheSamePeerFingerprint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{Cfg: &bootstrap.ServerConfig{}}).Router(context.Background(), testMux.Router))
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

	firstClaims, err := auth_svc.Default().ResolveCredential(context.Background(), firstToken)
	require.NoError(t, err)
	secondClaims, err := auth_svc.Default().ResolveCredential(context.Background(), secondToken)
	require.NoError(t, err)
	require.Equal(t, credstore.AccountPeerFingerprint(7), firstClaims.PeerFingerprint)
	require.Equal(t, firstClaims.PeerFingerprint, secondClaims.PeerFingerprint)
	// 浏览器拿到的对端指纹就是票里那个身份，两者不能各说各的。字段名也必须是
	// peer_fingerprint：同一个值在 /v1/agent-sessions、/v1/session-import 和
	// dispatch 的上行里一律叫这个名字；不能叫 client_id——client_id
	// 在同一个服务的 /v1/oauth/* 底下是 RFC 6749 的注册客户端，不是指纹。
	require.Equal(t, firstClaims.PeerFingerprint, firstPFP)
	require.Equal(t, firstPFP, secondPFP)
	require.Zero(t, firstClaims.DeviceID, "网页仍然不是设备")
}
