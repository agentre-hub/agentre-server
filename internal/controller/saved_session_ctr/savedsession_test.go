package saved_session_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/saved_session_svc"
)

const testCookieName = "server_session"

// stubSavedSessionSvc 内存持有账号里已保存的对话，用来测 HTTP 接缝：路由、鉴权、
// CSRF、账号作用域（user_id 取自会话 / JWT，不由请求体提供）。幂等由本桩复刻
// service 的语义：同一条重复保存不重复入桶，删除不存在的不是错误。
// peerOutcome 决定删除时执行端那一份的去向，让控制器如实转述这件事。
type stubSavedSessionSvc struct {
	saved       map[int64][]saved_session_svc.SavedSessionRef
	peerOutcome saved_session_svc.MachineDeleteOutcome
}

// 两条对话的 conversation_id（决策 1 的 UUIDv7 规范形式）。
const (
	conversationNine  = "3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"
	conversationEight = "5b8c9d2e-1f30-7c55-b214-9d7e3a6b0c11"
)

func newStubSavedSessionSvc() *stubSavedSessionSvc {
	return &stubSavedSessionSvc{
		saved:       map[int64][]saved_session_svc.SavedSessionRef{},
		peerOutcome: saved_session_svc.MachineDeleted,
	}
}

func (s *stubSavedSessionSvc) Save(_ context.Context, ref saved_session_svc.SessionRef) error {
	for _, it := range s.saved[ref.UserID] {
		if it.DeviceFingerprint == ref.MachineFingerprint && it.ConversationID == ref.ConversationID {
			return nil // 幂等：已经保存过
		}
	}
	s.saved[ref.UserID] = append(s.saved[ref.UserID], saved_session_svc.SavedSessionRef{
		DeviceFingerprint: ref.MachineFingerprint, ConversationID: ref.ConversationID, FollowedAt: 1000,
	})
	return nil
}

func (s *stubSavedSessionSvc) Delete(
	_ context.Context, ref saved_session_svc.SessionRef,
) (saved_session_svc.MachineDeleteOutcome, error) {
	items := s.saved[ref.UserID]
	for i, it := range items {
		// 删除按身份：这个桩里两个指纹同值（桌面端那一档），拿哪一个都行，
		// 用发起端是为了跟真实现同一口径。
		if it.ConversationID == ref.ConversationID {
			s.saved[ref.UserID] = append(items[:i], items[i+1:]...)
			break
		}
	}
	return s.peerOutcome, nil // 幂等：从未保存过也照样成功
}

func (s *stubSavedSessionSvc) List(_ context.Context, userID int64) ([]saved_session_svc.SavedSessionRef, error) {
	return s.saved[userID], nil
}

func newSavedSessionTestServer(t *testing.T, stub *stubSavedSessionSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t) // miniredis → session 存储 + jwt 黑名单
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	saved_session_svc.SetDefault(stub)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))

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

// 保存：已登录浏览器 session 把一条对话收进账号；同账号另一个 session（另一个
// 浏览器 = 另一端）读到同一份——账号里保存的对话属于账号，不属于某一个浏览器。
func TestSave_OneEndSaves_OtherEndReadsSameList(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server, _ := newSavedSessionTestServer(t, stub)

	cookieA, csrfA := newSessionCookie(t, 7)
	cookieB, _ := newSessionCookie(t, 7) // 同账号的另一端

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookieA.Value, "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrfA)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	resp = doRequest(t, http.MethodGet, server.URL+"/v1/follows", cookieB.Value, "", "")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Items []struct {
				DeviceFingerprint string `json:"device_fingerprint"`
				ConversationID    string `json:"conversation_id"`
				FollowedAt        int64  `json:"followed_at"`
				Invalid           bool   `json:"invalid"`
			} `json:"items"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	require.Len(t, envelope.Data.Items, 1)
	require.Equal(t, "fp-daemon-1", envelope.Data.Items[0].DeviceFingerprint)
	require.Equal(t, conversationNine, envelope.Data.Items[0].ConversationID)
}

// 账号隔离：另一个账号看不到这条。
func TestList_ScopedToAccount(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server, _ := newSavedSessionTestServer(t, stub)

	cookieA, csrfA := newSessionCookie(t, 7)
	cookieOther, _ := newSessionCookie(t, 99)

	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookieA.Value, "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrfA)

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

// peerStatus 读出删除应答里执行端那一份的去向。
func peerStatus(t *testing.T, resp *http.Response) string {
	t.Helper()
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			MachineStatus string `json:"machine_status"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&envelope))
	require.Equal(t, 0, envelope.Code)
	return envelope.Data.MachineStatus
}

// 删除：只删这一条；机器在线时应答如实说执行端那一份也删掉了。
func TestDelete_RemovesOnlyThatEntry(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server, _ := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrf)
	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationEight+`"}`, csrf)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/delete",
		cookie.Value, "", `{"conversation_id":"`+conversationNine+`"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "deleted", peerStatus(t, resp))

	items := stub.saved[7]
	require.Len(t, items, 1)
	require.Equal(t, conversationEight, items[0].ConversationID)
}

// 机器离线：应答如实说执行端那一份还欠着（server 那份已经没了），前端据此说明
// 那台机器回来时会补删——而不是谎称两边都清干净了。
func TestDelete_PeerOffline_ReportsPending(t *testing.T) {
	stub := newStubSavedSessionSvc()
	stub.peerOutcome = saved_session_svc.MachineDeletePending
	server, _ := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrf)
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/delete",
		cookie.Value, "", `{"conversation_id":"`+conversationNine+`"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "pending", peerStatus(t, resp))
	require.Empty(t, stub.saved[7])
}

// 浏览器 session 的写操作必须出示 CSRF，否则 403（与 revoke / logout 同组约定）。
func TestSave_RejectsMissingCSRF(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server, _ := newSavedSessionTestServer(t, stub)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Empty(t, stub.saved[7])
}

// 删除是破坏性的，同样必须出示 CSRF：一个跨站表单不能替用户清掉两台机器上的对话。
func TestDelete_RejectsMissingCSRF(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server, _ := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrf)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/delete",
		cookie.Value, "", `{"conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Len(t, stub.saved[7], 1)
}

// 设备 JWT 调用方不带 cookie，结构上不受 CSRF 威胁：保存照常成功。
func TestSave_DeviceJWT_NoCSRFNeeded(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server, signer := newSavedSessionTestServer(t, stub)
	token, _, err := signer.Sign(jwt.Claims{UID: 7, DID: 1, Kind: device_entity.KindAgentred}, time.Hour)
	require.NoError(t, err)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		"", token, `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Len(t, stub.saved[7], 1)
}

// 未登录请求（无 cookie、无 Bearer）被 SessionOrDeviceAuth 拒绝（401）。
func TestSave_UnauthenticatedRejected(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server, _ := newSavedSessionTestServer(t, stub)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		"", "", `{"machine_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	require.Empty(t, stub.saved[7])
}

var _ saved_session_svc.SavedSessionSvc = (*stubSavedSessionSvc)(nil)
