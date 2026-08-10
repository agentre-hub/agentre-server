package follow_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/api"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/model/entity/device_entity"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/pkg/session"
	"agentre-server/internal/service/auth_svc"
	"agentre-server/internal/service/follow_svc"
)

const testCookieName = "server_session"

// stubFollowSvc 内存持有名单（按账号分桶），用来测 HTTP 接缝：路由、鉴权、CSRF、
// 账号作用域（user_id 取自会话 / JWT，不由请求体提供）。幂等由本桩复刻 repo 的
// 语义：同（指纹, 会话）重复关注不重复入桶。
type stubFollowSvc struct {
	follows map[int64][]follow_svc.FollowItem
}

func newStubFollowSvc() *stubFollowSvc {
	return &stubFollowSvc{follows: map[int64][]follow_svc.FollowItem{}}
}

func (s *stubFollowSvc) Follow(_ context.Context, in follow_svc.FollowInput) error {
	for _, it := range s.follows[in.UserID] {
		if it.DeviceFingerprint == in.DeviceFingerprint && it.SessionID == in.SessionID {
			return nil // 幂等：已关注
		}
	}
	s.follows[in.UserID] = append(s.follows[in.UserID], follow_svc.FollowItem{
		DeviceFingerprint: in.DeviceFingerprint, SessionID: in.SessionID, FollowedAt: 1000,
	})
	return nil
}

func (s *stubFollowSvc) Unfollow(_ context.Context, in follow_svc.FollowInput) error {
	items := s.follows[in.UserID]
	for i, it := range items {
		if it.DeviceFingerprint == in.DeviceFingerprint && it.SessionID == in.SessionID {
			s.follows[in.UserID] = append(items[:i], items[i+1:]...)
			return nil
		}
	}
	return nil // 幂等：从未关注
}

func (s *stubFollowSvc) List(_ context.Context, userID int64) ([]follow_svc.FollowItem, error) {
	return s.follows[userID], nil
}

func newFollowTestServer(t *testing.T, stub *stubFollowSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis() // miniredis → session 存储 + jwt 黑名单
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	follow_svc.SetDefault(stub)
	auth_svc.SetDefault(auth_svc.New(session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server, signer
}

func newSessionCookie(t *testing.T, userID int64) (*http.Cookie, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return &http.Cookie{Name: testCookieName, Value: sid}, sess.CSRFToken
}

func doRequest(t *testing.T, method, url, cookie, bearer, body string, csrf ...string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	require.NoError(t, err)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: testCookieName, Value: cookie})
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if len(csrf) > 0 && csrf[0] != "" {
		req.Header.Set("X-CSRF-Token", csrf[0])
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// R12 + R14：已登录浏览器 session 关注一条会话；同账号另一个 session（另一个
// 浏览器 = 另一端）读到同一份名单——名单属于账号，不属于某一个浏览器。
func TestFollow_OneEndFollows_OtherEndReadsSameList(t *testing.T) {
	stub := newStubFollowSvc()
	server, _ := newFollowTestServer(t, stub)

	cookieA, csrfA := newSessionCookie(t, 7)
	cookieB, _ := newSessionCookie(t, 7) // 同账号的另一端

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/follows",
		cookieA.Value, "", `{"device_fingerprint":"fp-daemon-1","session_id":"sess-9"}`, csrfA)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// 另一端读名单：同一条已在里面。
	resp = doRequest(t, http.MethodGet, server.URL+"/v1/follows", cookieB.Value, "", "")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Items []struct {
				DeviceFingerprint string `json:"device_fingerprint"`
				SessionID         string `json:"session_id"`
				FollowedAt        int64  `json:"followed_at"`
				Invalid           bool   `json:"invalid"`
			} `json:"items"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	require.Len(t, envelope.Data.Items, 1)
	require.Equal(t, "fp-daemon-1", envelope.Data.Items[0].DeviceFingerprint)
	require.Equal(t, "sess-9", envelope.Data.Items[0].SessionID)
}

// R14：名单按账号隔离——另一个账号看不到这条。
func TestList_ScopedToAccount(t *testing.T) {
	stub := newStubFollowSvc()
	server, _ := newFollowTestServer(t, stub)

	cookieA, csrfA := newSessionCookie(t, 7)
	cookieOther, _ := newSessionCookie(t, 99)

	doRequest(t, http.MethodPost, server.URL+"/v1/follows",
		cookieA.Value, "", `{"device_fingerprint":"fp-daemon-1","session_id":"sess-9"}`, csrfA)

	resp := doRequest(t, http.MethodGet, server.URL+"/v1/follows", cookieOther.Value, "", "")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Items []json.RawMessage `json:"items"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	require.Empty(t, envelope.Data.Items)
}

// R12：取消关注只去掉这一条；同账号其余关注不受影响。session 写操作必须带 CSRF。
func TestUnfollow_RemovesOnlyThatEntry(t *testing.T) {
	stub := newStubFollowSvc()
	server, _ := newFollowTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	doRequest(t, http.MethodPost, server.URL+"/v1/follows",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","session_id":"sess-9"}`, csrf)
	doRequest(t, http.MethodPost, server.URL+"/v1/follows",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","session_id":"sess-8"}`, csrf)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/follows/unfollow",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","session_id":"sess-9"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	items := stub.follows[7]
	require.Len(t, items, 1)
	require.Equal(t, "sess-8", items[0].SessionID)
}

// R12：浏览器 session 的写操作必须出示 CSRF，否则 403（与 revoke / logout 同组约定）。
func TestFollow_RejectsMissingCSRF(t *testing.T) {
	stub := newStubFollowSvc()
	server, _ := newFollowTestServer(t, stub)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/follows",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","session_id":"sess-9"}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Empty(t, stub.follows[7])
}

// 设备 JWT 调用方不带 cookie，结构上不受 CSRF 威胁：关注照常成功。
func TestFollow_DeviceJWT_NoCSRFNeeded(t *testing.T) {
	stub := newStubFollowSvc()
	server, signer := newFollowTestServer(t, stub)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 1, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/follows",
		"", token, `{"device_fingerprint":"fp-daemon-1","session_id":"sess-9"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Len(t, stub.follows[7], 1)
}

// 未登录请求（无 cookie、无 Bearer）被 SessionOrDeviceAuth 拒绝（401）。
func TestFollow_UnauthenticatedRejected(t *testing.T) {
	stub := newStubFollowSvc()
	server, _ := newFollowTestServer(t, stub)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/follows",
		"", "", `{"device_fingerprint":"fp-daemon-1","session_id":"sess-9"}`)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	require.Empty(t, stub.follows[7])
}

var _ follow_svc.FollowSvc = (*stubFollowSvc)(nil)
