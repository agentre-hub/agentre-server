package credentials_ctr_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/credstore"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/testutils"
)

const testCookieName = "server_session"

// newIntrospectServer 装出完整路由树：调用方自己的设备 access token 走
// bearertest.Resolver（DeviceJWT 那组），待核验令牌可以是任意一种——设备 access
// token 经同一个 bearertest.Resolver，中继票据与 server 自用凭据经真实
// auth_svc/credstore（backed by 注入的 miniredis）。
func newIntrospectServer(t *testing.T, quota int64) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{CredentialsIntrospectPerAccountPerMin: quota}},
		Bearer: bearertest.Resolver{},
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server
}

type introspectEnvelope struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		AccountID       string `json:"account_id"`
		DeviceID        int64  `json:"device_id"`
		Kind            string `json:"kind"`
		PeerFingerprint string `json:"peer_fingerprint"`
		ExpiresIn       int64  `json:"expires_in"`
	} `json:"data"`
}

// introspect 用 callerToken 当调用方自己的设备 access token，去核验 targetToken。
func introspect(t *testing.T, server *httptest.Server, callerToken, targetToken string) *http.Response {
	t.Helper()
	body := fmt.Sprintf(`{"token":%q}`, targetToken)
	req, err := http.NewRequest(http.MethodPost, server.URL+"/v1/credentials/introspect", strings.NewReader(body))
	require.NoError(t, err)
	if callerToken != "" {
		req.Header.Set("Authorization", "Bearer "+callerToken)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func decodeIntrospect(t *testing.T, resp *http.Response) introspectEnvelope {
	t.Helper()
	var envelope introspectEnvelope
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	return envelope
}

// newSessionCookie 建一次浏览器登录会话，用来经 /v1/relay/ticket 换真实中继票据。
func newSessionCookie(t *testing.T, userID int64) (*http.Cookie, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return &http.Cookie{Name: testCookieName, Value: sid}, sess.CSRFToken
}

func issueRelayTicket(t *testing.T, server *httptest.Server, accountID int64) string {
	t.Helper()
	cookie, csrf := newSessionCookie(t, accountID)
	req, err := http.NewRequest(http.MethodPost, server.URL+"/v1/relay/ticket", strings.NewReader(`{}`))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("X-CSRF-Token", csrf)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Data struct {
			AccessToken string `json:"access_token"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	return envelope.Data.AccessToken
}

// S5 同账号：设备 access token 核验出完整身份与剩余有效期。
func TestIntrospect_DeviceToken_SameAccount_ReturnsIdentity(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", PeerFingerprint: "caller-pfp", Handle: "1"})
	target := bearertest.Issue(device_svc.Principal{
		AccountID: 7, DeviceID: 2, Kind: "agentred", PeerFingerprint: "peer-pfp",
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(), Handle: "2",
	})

	resp := introspect(t, server, caller, target)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	envelope := decodeIntrospect(t, resp)
	assert.Equal(t, "7", envelope.Data.AccountID)
	assert.Equal(t, int64(2), envelope.Data.DeviceID)
	assert.Equal(t, "agentred", envelope.Data.Kind)
	assert.Equal(t, "peer-pfp", envelope.Data.PeerFingerprint)
	assert.InDelta(t, 3600, envelope.Data.ExpiresIn, 5)
}

// 剩余不足一秒的有效令牌答 expires_in=1 而不是 0：接收方把 0 读作「没说剩多久」，会按
// 整 60 秒缓存这次核验，让一枚马上过期的凭据多活一分钟。
func TestIntrospect_ValidTokenWithUnderASecondLeft_ReportsOneSecondNotZero(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", PeerFingerprint: "caller-pfp", Handle: "1"})
	target := bearertest.Issue(device_svc.Principal{
		AccountID: 7, DeviceID: 2, Kind: "agentred", PeerFingerprint: "peer-pfp",
		ExpiresAt: time.Now().Add(800 * time.Millisecond).UnixMilli(), Handle: "2",
	})

	resp := introspect(t, server, caller, target)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, int64(1), decodeIntrospect(t, resp).Data.ExpiresIn)
}

// S5 同账号：中继票据（浏览器 relay_client）核验出 device_id=0、kind=relay_client。
func TestIntrospect_RelayTicket_SameAccount_ReturnsIdentity(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	ticket := issueRelayTicket(t, server, 7)

	resp := introspect(t, server, caller, ticket)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	envelope := decodeIntrospect(t, resp)
	assert.Equal(t, "7", envelope.Data.AccountID)
	assert.Zero(t, envelope.Data.DeviceID)
	assert.Equal(t, credstore.KindRelayClient, envelope.Data.Kind)
	assert.Equal(t, credstore.AccountPeerFingerprint(7), envelope.Data.PeerFingerprint)
	assert.InDelta(t, 120, envelope.Data.ExpiresIn, 5)
}

// S5 同账号：server 自用（镜像/端口转发）凭据同样核验得出，kind=server_mirror。
func TestIntrospect_ServerMirrorCredential_SameAccount_ReturnsIdentity(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	mirror, err := credstore.New(redis.Default()).IssueServerMirror(context.Background(), 7, "server-mirror:a")
	require.NoError(t, err)

	resp := introspect(t, server, caller, mirror)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	envelope := decodeIntrospect(t, resp)
	assert.Equal(t, "7", envelope.Data.AccountID)
	assert.Zero(t, envelope.Data.DeviceID)
	assert.Equal(t, credstore.KindServerMirror, envelope.Data.Kind)
	assert.Equal(t, "server-mirror:a", envelope.Data.PeerFingerprint)
}

// S5 跨账号：核验出的账号与调用方不同——统一答无效，不透出「这令牌其实属于别的账号」。
func TestIntrospect_CrossAccountDeviceToken_ReturnsInvalidCode(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	target := bearertest.Issue(device_svc.Principal{AccountID: 9, DeviceID: 2, Kind: "agentred", Handle: "2"})

	resp := introspect(t, server, caller, target)
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	envelope := decodeIntrospect(t, resp)
	assert.Equal(t, code.CredentialInvalid, envelope.Code)
}

func TestIntrospect_CrossAccountRelayTicket_ReturnsInvalidCode(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	ticket := issueRelayTicket(t, server, 9)

	resp := introspect(t, server, caller, ticket)
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	envelope := decodeIntrospect(t, resp)
	assert.Equal(t, code.CredentialInvalid, envelope.Code)
}

// 未知、过期、已撤销的设备 access token 在 device_svc 那一侧已经是同一种
// ErrBearerInvalid（不区分三者，见 device_svc.ResolveBearer 的文档），这里只需证明
// 控制器把它映射到同一个业务码——与跨账号那条答复形状完全一致，不多一个字段、不少
// 一个字段，持有者与调用方都分不出到底是哪一种。
func TestIntrospect_UnknownToken_ReturnsInvalidCode_SameShapeAsCrossAccount(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	crossAccountTarget := bearertest.Issue(device_svc.Principal{AccountID: 9, DeviceID: 2, Kind: "agentred", Handle: "2"})

	unknownResp := introspect(t, server, caller, "this-token-was-never-issued")
	require.Equal(t, http.StatusBadRequest, unknownResp.StatusCode)
	unknown := decodeIntrospect(t, unknownResp)

	crossResp := introspect(t, server, caller, crossAccountTarget)
	require.Equal(t, http.StatusBadRequest, crossResp.StatusCode)
	cross := decodeIntrospect(t, crossResp)

	assert.Equal(t, code.CredentialInvalid, unknown.Code)
	assert.Equal(t, cross.Code, unknown.Code, "跨账号与未知/过期/撤销必须答同一个业务码")
	assert.Equal(t, cross.Msg, unknown.Msg, "文案也必须一致，否则等于用 msg 泄露了原因")
}

// 空 body / 空 token 与其它无效情形同一种答复，不因为「没带」而单独判成别的形状。
func TestIntrospect_MissingOrEmptyToken_ReturnsInvalidCode(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})

	for name, body := range map[string]string{"空 body": `{}`, "空字符串 token": `{"token":""}`} {
		t.Run(name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, server.URL+"/v1/credentials/introspect", strings.NewReader(body))
			require.NoError(t, err)
			req.Header.Set("Authorization", "Bearer "+caller)
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			t.Cleanup(func() { _ = resp.Body.Close() })
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			envelope := decodeIntrospect(t, resp)
			assert.Equal(t, code.CredentialInvalid, envelope.Code)
		})
	}
}

// 中继票据连过一次中继之后仍然可以被反复核验——核验走的是 Resolve，不是
// ClaimRelayConnect，「只连一次」的认领记号与核验互不干扰。
func TestIntrospect_TicketAfterItsRelayConnect_StillIntrospects(t *testing.T) {
	server := newIntrospectServer(t, 100)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	ticket := issueRelayTicket(t, server, 7)

	p, err := auth_svc.Default().ResolveCredential(context.Background(), ticket)
	require.NoError(t, err)
	first, err := credstore.New(redis.Default()).ClaimRelayConnect(context.Background(), p.Handle)
	require.NoError(t, err)
	require.True(t, first, "这是这张票第一次认领连接")

	resp := introspect(t, server, caller, ticket)
	require.Equal(t, http.StatusOK, resp.StatusCode, "认领过连接的票据仍然核验得出身份")
	envelope := decodeIntrospect(t, resp)
	assert.Equal(t, credstore.KindRelayClient, envelope.Data.Kind)
}

// Redis 不可用：中继票据判不出来，答 503（不是「无效」那个码，也不是 401）；
// 设备 access token 的核验完全不经 Redis，照常成功。
func TestIntrospect_RedisDown_TicketAnswers503_DeviceTokenStillSucceeds(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mini := testutils.Redis(t)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))
	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{CredentialsIntrospectPerAccountPerMin: 100}},
		Bearer: bearertest.Resolver{},
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)

	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	ticket := issueRelayTicket(t, server, 7)
	target := bearertest.Issue(device_svc.Principal{
		AccountID: 7, DeviceID: 2, Kind: "agentred", PeerFingerprint: "peer-pfp",
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(), Handle: "2",
	})

	mini.Close()

	ticketResp := introspect(t, server, caller, ticket)
	assert.Equal(t, http.StatusServiceUnavailable, ticketResp.StatusCode, "Redis 不可用时票据判不出来，答服务器错误而不是「无效」")

	deviceResp := introspect(t, server, caller, target)
	require.Equal(t, http.StatusOK, deviceResp.StatusCode, "设备 access token 的核验只读 MySQL，Redis 停摆不影响它")
}

// 调用方不能是浏览器 session——这条端点要求调用方出示自己的设备 access token。
func TestIntrospect_CallerIsSessionCookie_Returns401(t *testing.T) {
	server := newIntrospectServer(t, 100)
	cookie, _ := newSessionCookie(t, 7)
	target := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 2, Kind: "agentred", Handle: "2"})

	req, err := http.NewRequest(http.MethodPost, server.URL+"/v1/credentials/introspect",
		strings.NewReader(fmt.Sprintf(`{"token":%q}`, target)))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 调用方不能是中继票据——DeviceJWT 那组只认设备 access token。
func TestIntrospect_CallerIsRelayTicket_Returns401(t *testing.T) {
	server := newIntrospectServer(t, 100)
	ticket := issueRelayTicket(t, server, 7)
	target := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 2, Kind: "agentred", Handle: "2"})

	resp := introspect(t, server, ticket, target)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 调用方不能是 server 自用凭据——同理，DeviceJWT 那组只认设备 access token。
func TestIntrospect_CallerIsServerMirrorCredential_Returns401(t *testing.T) {
	server := newIntrospectServer(t, 100)
	mirror, err := credstore.New(redis.Default()).IssueServerMirror(context.Background(), 7, "server-mirror:a")
	require.NoError(t, err)
	target := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 2, Kind: "agentred", Handle: "2"})

	resp := introspect(t, server, mirror, target)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 端点受速率限制：按调用方账号计，超额答 429。
func TestIntrospect_RateLimitExceeded_Returns429(t *testing.T) {
	server := newIntrospectServer(t, 1)
	caller := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: "desktop", Handle: "1"})
	target := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 2, Kind: "agentred", Handle: "2"})

	first := introspect(t, server, caller, target)
	require.Equal(t, http.StatusOK, first.StatusCode)

	second := introspect(t, server, caller, target)
	assert.Equal(t, http.StatusTooManyRequests, second.StatusCode)
}
