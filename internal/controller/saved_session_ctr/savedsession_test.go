package saved_session_ctr_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/middleware/bearertest"
	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
	"github.com/agentre-hub/agentre-server/internal/service/saved_session_svc"
)

const testCookieName = "server_session"

// stubSavedSessionSvc 内存持有账号里已保存的对话，用来测 HTTP 接缝：路由、鉴权、
// CSRF、账号作用域（user_id 取自会话 / JWT，不由请求体提供）。幂等由本桩复刻
// service 的语义：同一条重复保存不重复入桶，删除不存在的不是错误。
// peerOutcome 决定删除时执行端那一份的去向，让控制器如实转述这件事。
type stubSavedSessionSvc struct {
	saved       map[int64][]saved_session_svc.SessionRef
	peerOutcome saved_session_svc.MachineDeleteOutcome
	// lastDelete 是最近一次 Delete 收到的入参，用来核对控制器转交了什么。
	lastDelete saved_session_svc.SessionRef
	// 清理：preview / result 是桩要交回的东西，last* 记下控制器转交了什么。
	preview       saved_session_svc.CleanupPreview
	result        saved_session_svc.CleanupResult
	lastPreviewBy int64
	lastFilter    saved_session_svc.CleanupFilter
	lastCleanup   struct {
		userID, callerDevice int64
		ids                  []string
	}
}

func (s *stubSavedSessionSvc) PreviewCleanup(
	_ context.Context, userID int64, f saved_session_svc.CleanupFilter,
) (saved_session_svc.CleanupPreview, error) {
	s.lastPreviewBy, s.lastFilter = userID, f
	return s.preview, nil
}

func (s *stubSavedSessionSvc) Cleanup(
	_ context.Context, userID, callerDevice int64, ids []string,
) (saved_session_svc.CleanupResult, error) {
	s.lastCleanup.userID, s.lastCleanup.callerDevice, s.lastCleanup.ids = userID, callerDevice, ids
	return s.result, nil
}

// 两条对话的 conversation_id（决策 1 的 UUIDv7 规范形式）。
const (
	conversationNine  = "3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"
	conversationEight = "5b8c9d2e-1f30-7c55-b214-9d7e3a6b0c11"
)

func newStubSavedSessionSvc() *stubSavedSessionSvc {
	return &stubSavedSessionSvc{
		saved:       map[int64][]saved_session_svc.SessionRef{},
		peerOutcome: saved_session_svc.MachineDeleted,
	}
}

func (s *stubSavedSessionSvc) Save(_ context.Context, ref saved_session_svc.SessionRef) error {
	for _, it := range s.saved[ref.UserID] {
		if it.MachineFingerprint == ref.MachineFingerprint && it.ConversationID == ref.ConversationID {
			return nil // 幂等：已经保存过
		}
	}
	s.saved[ref.UserID] = append(s.saved[ref.UserID], ref)
	return nil
}

func (s *stubSavedSessionSvc) Delete(
	_ context.Context, ref saved_session_svc.SessionRef,
) (saved_session_svc.MachineDeleteOutcome, error) {
	s.lastDelete = ref
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

func newSavedSessionTestServer(t *testing.T, stub *stubSavedSessionSvc) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t) // miniredis → session 存储 + 中继票据黑名单
	saved_session_svc.SetDefault(stub)
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Bearer: bearertest.Resolver{},
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server
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
	// 真实浏览器给同源请求带这个头，加固层（middleware.originOK）据此放行。
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
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
	server := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrf)
	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","conversation_id":"`+conversationEight+`"}`, csrf)

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
	server := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrf)
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/delete",
		cookie.Value, "", `{"conversation_id":"`+conversationNine+`"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "pending", peerStatus(t, resp))
	require.Empty(t, stub.saved[7])
}

// 浏览器 session 的写操作必须出示 CSRF，否则 403（与 revoke / logout 同组约定）。
func TestSave_RejectsMissingCSRF(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	cookie, _ := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Empty(t, stub.saved[7])
}

// 删除是破坏性的，同样必须出示 CSRF：一个跨站表单不能替用户清掉两台机器上的对话。
func TestDelete_RejectsMissingCSRF(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		cookie.Value, "", `{"device_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`, csrf)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/delete",
		cookie.Value, "", `{"conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Len(t, stub.saved[7], 1)
}

// 设备 JWT 调用方不带 cookie，结构上不受 CSRF 威胁：保存照常成功。
func TestSave_DeviceJWT_NoCSRFNeeded(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	token := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 1, Kind: device_entity.KindAgentred})

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		"", token, `{"device_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Len(t, stub.saved[7], 1)
}

// 未登录请求（无 cookie、无 Bearer）被 SessionOrDeviceAuth 拒绝（401）。
func TestSave_UnauthenticatedRejected(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions",
		"", "", `{"device_fingerprint":"fp-daemon-1","conversation_id":"`+conversationNine+`"}`)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	require.Empty(t, stub.saved[7])
}

var _ saved_session_svc.SavedSessionSvc = (*stubSavedSessionSvc)(nil)

// 桌面（设备 JWT）删除自己的对话：machine_fingerprint 原样交给 service，调用设备 id 取自
// JWT——service 据此不回头通知它。
func TestDelete_DeviceJWT_ForwardsMachineFingerprintAndCallerDevice(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	token := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 4, Kind: device_entity.KindDesktop})

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/delete",
		"", token, `{"conversation_id":"`+conversationNine+`","machine_fingerprint":"fp-agentred-1"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, int64(7), stub.lastDelete.UserID)
	require.Equal(t, "fp-agentred-1", stub.lastDelete.MachineFingerprint)
	require.Equal(t, int64(4), stub.lastDelete.CallerDeviceID)
}

// 浏览器会话没有调用设备；machine_fingerprint 可省。
func TestDelete_Session_HasNoCallerDevice(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/delete",
		cookie.Value, "", `{"conversation_id":"`+conversationNine+`"}`, csrf)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Zero(t, stub.lastDelete.CallerDeviceID)
	require.Empty(t, stub.lastDelete.MachineFingerprint)
}

// 预览：条件原样交给 service，账号取自会话而不是请求体；应答字段名就是对外契约。
func TestCleanupPreview_ForwardsFilterAndRendersContract(t *testing.T) {
	stub := newStubSavedSessionSvc()
	stub.preview = saved_session_svc.CleanupPreview{
		Count: 2, Retained: 1, ConversationIDs: []string{conversationNine, conversationEight},
		Machines: []saved_session_svc.CleanupMachine{{Fingerprint: "fp-1", Name: "box", Online: true, Count: 2}},
	}
	server := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/cleanup/preview", cookie.Value, "",
		`{"before_ms":5000,"agent_sync_id":"a1","project_sync_id":"p1","user_id":99}`, csrf)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, int64(7), stub.lastPreviewBy)
	require.Equal(t, saved_session_svc.CleanupFilter{BeforeMs: 5000, AgentSyncID: "a1", ProjectSyncID: "p1"}, stub.lastFilter)
	var env struct {
		Code int `json:"code"`
		Data struct {
			Count           int      `json:"count"`
			Retained        int      `json:"retained"`
			ConversationIDs []string `json:"conversation_ids"`
			Machines        []struct {
				Fingerprint string `json:"fingerprint"`
				Name        string `json:"name"`
				Online      bool   `json:"online"`
				Count       int    `json:"count"`
			} `json:"machines"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&env))
	require.Equal(t, 0, env.Code)
	require.Equal(t, 2, env.Data.Count)
	require.Equal(t, 1, env.Data.Retained)
	require.Equal(t, []string{conversationNine, conversationEight}, env.Data.ConversationIDs)
	require.Len(t, env.Data.Machines, 1)
	require.Equal(t, "fp-1", env.Data.Machines[0].Fingerprint)
	require.Equal(t, "box", env.Data.Machines[0].Name)
	require.True(t, env.Data.Machines[0].Online)
	require.Equal(t, 2, env.Data.Machines[0].Count)
}

func TestCleanupPreview_RejectsNegativeBefore(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/cleanup/preview", cookie.Value, "",
		`{"before_ms":-1}`, csrf)
	require.NotEqual(t, http.StatusOK, resp.StatusCode)
}

func TestCleanupPreview_UnauthenticatedRejected(t *testing.T) {
	server := newSavedSessionTestServer(t, newStubSavedSessionSvc())
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/cleanup/preview", "", "", `{}`)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 执行：id 列表与账号 / 调用设备交给 service；应答字段名就是对外契约。
func TestCleanup_ForwardsIDsAndCallerDeviceAndRendersContract(t *testing.T) {
	stub := newStubSavedSessionSvc()
	stub.result = saved_session_svc.CleanupResult{
		Deleted: 1, Retained: 1,
		Failed:  []saved_session_svc.CleanupFailure{{ConversationID: conversationEight, Reason: "delete_failed"}},
		Pending: []saved_session_svc.CleanupPendingMachine{{Fingerprint: "fp-1", Name: "box", Count: 3}},
	}
	server := newSavedSessionTestServer(t, stub)
	token := bearertest.Issue(device_svc.Principal{AccountID: 7, DeviceID: 4, Kind: device_entity.KindDesktop})

	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/cleanup", "", token,
		`{"conversation_ids":["`+conversationNine+`","`+conversationEight+`"]}`)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, int64(7), stub.lastCleanup.userID)
	require.Equal(t, int64(4), stub.lastCleanup.callerDevice)
	require.Equal(t, []string{conversationNine, conversationEight}, stub.lastCleanup.ids)
	var env struct {
		Data struct {
			Deleted  int `json:"deleted"`
			Retained int `json:"retained"`
			Failed   []struct {
				ConversationID string `json:"conversation_id"`
				Reason         string `json:"reason"`
			} `json:"failed"`
			Pending []struct {
				Fingerprint string `json:"fingerprint"`
				Name        string `json:"name"`
				Count       int    `json:"count"`
			} `json:"pending"`
		} `json:"data"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&env))
	require.Equal(t, 1, env.Data.Deleted)
	require.Equal(t, 1, env.Data.Retained)
	require.Len(t, env.Data.Failed, 1)
	require.Equal(t, conversationEight, env.Data.Failed[0].ConversationID)
	require.Equal(t, "delete_failed", env.Data.Failed[0].Reason)
	require.Len(t, env.Data.Pending, 1)
	require.Equal(t, "fp-1", env.Data.Pending[0].Fingerprint)
	require.Equal(t, 3, env.Data.Pending[0].Count)
}

// 浏览器会话的清理是破坏性写操作：必须出示 CSRF。
func TestCleanup_RejectsMissingCSRF(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	cookie, _ := newSessionCookie(t, 7)
	resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/cleanup", cookie.Value, "",
		`{"conversation_ids":["`+conversationNine+`"]}`)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.Empty(t, stub.lastCleanup.ids)
}

func TestCleanup_RejectsEmptyAndMalformedIDs(t *testing.T) {
	stub := newStubSavedSessionSvc()
	server := newSavedSessionTestServer(t, stub)
	cookie, csrf := newSessionCookie(t, 7)
	for _, body := range []string{`{"conversation_ids":[]}`, `{}`, `{"conversation_ids":["not-a-uuid"]}`} {
		resp := doRequest(t, http.MethodPost, server.URL+"/v1/saved-sessions/cleanup", cookie.Value, "", body, csrf)
		require.NotEqual(t, http.StatusOK, resp.StatusCode, body)
	}
	require.Empty(t, stub.lastCleanup.ids)
}
