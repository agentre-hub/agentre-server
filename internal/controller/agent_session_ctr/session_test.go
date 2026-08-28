package agent_session_ctr_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

const testCookieName = "server_session"

// stubWorkspaceSvc 只实现 workspace_svc.SessionReadSvc——agent_session_ctr 用到的就是这
// 三个方法。router.go 把 agent_session_ctr 与 workspace_ctr 绑在同一棵路由树上，但两者
// 各取各的那一片：组织面那 12 个方法仍走 workspace_svc.Default() 的真实实现，
// 本包的测试不碰那些路由，因此不需要替身。
type stubWorkspaceSvc struct {
	index      workspace_svc.SessionIndexPage
	indexErr   error
	indexInput workspace_svc.SessionIndexQuery
	// markReadInput 记 (账号, 发起端指纹, 会话标识)：控制器只负责把它们原样转下去。
	markReadInput [3]string
	markReadAt    int64
	markReadErr   error

	page       workspace_svc.TranscriptPage
	transcript workspace_svc.TranscriptQuery

	waitingCount       int64
	waitingCountUserID int64
	waitingCountErr    error
}

func (s *stubWorkspaceSvc) SessionIndex(
	_ context.Context, in workspace_svc.SessionIndexQuery,
) (workspace_svc.SessionIndexPage, error) {
	s.indexInput = in
	if s.indexErr != nil {
		return workspace_svc.SessionIndexPage{}, s.indexErr
	}
	return s.index, nil
}

func (s *stubWorkspaceSvc) MarkSessionRead(
	_ context.Context, userID int64, peerFingerprint, sessionID string,
) (int64, error) {
	s.markReadInput = [3]string{
		strconv.FormatInt(userID, 10), peerFingerprint, sessionID,
	}
	if s.markReadErr != nil {
		return 0, s.markReadErr
	}
	return s.markReadAt, nil
}

func (s *stubWorkspaceSvc) Transcript(
	_ context.Context, in workspace_svc.TranscriptQuery,
) (workspace_svc.TranscriptPage, error) {
	s.transcript = in
	return s.page, nil
}

func (s *stubWorkspaceSvc) WaitingCount(_ context.Context, userID int64) (int64, error) {
	s.waitingCountUserID = userID
	if s.waitingCountErr != nil {
		return 0, s.waitingCountErr
	}
	return s.waitingCount, nil
}

var _ workspace_svc.SessionReadSvc = (*stubWorkspaceSvc)(nil)

func newMirrorTestServer(t *testing.T, stub *stubWorkspaceSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	workspace_svc.SetSessionRead(stub)
	t.Cleanup(func() { workspace_svc.SetSessionRead(workspace_svc.New()) })
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

func newSessionCookie(t *testing.T, userID int64) *http.Cookie {
	t.Helper()
	cookie, _ := newSessionCookieWithCSRF(t, userID)
	return cookie
}

// 写方法要带 CSRF 头：本组的 session 分支与 SessionAuth()+CSRF() 走同一条判据
// （session_or_device_auth.go）。
func newSessionCookieWithCSRF(t *testing.T, userID int64) (*http.Cookie, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return &http.Cookie{Name: testCookieName, Value: sid}, sess.CSRFToken
}

func get(t *testing.T, url, cookie string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: testCookieName, Value: cookie})
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func decodeEnvelope(t *testing.T, resp *http.Response, into any) {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(body, &envelope))
	require.Equal(t, 0, envelope.Code, "response body: %s", body)
	require.NoError(t, json.Unmarshal(envelope.Data, into))
}

// 摘要必须带发起端指纹与会话标识（决策 17 的身份键），少了它详情页发不出消息。
// 不带 scope 时给的是组骨架：每组带自己的真数，顶栏那个数是账号级的（决策 10）。
func TestSavedSessions_GroupSkeletonCarriesTotalsAndIdentity(t *testing.T) {
	stub := &stubWorkspaceSvc{index: workspace_svc.SessionIndexPage{
		Total: 137,
		Groups: []workspace_svc.SessionIndexGroup{{
			Scope: "agent:agent-1", Total: 9, HasMore: true, Cursor: "1700.42",
			Items: []workspace_svc.SavedSessionSummaryView{{
				PeerFingerprint: "fp-daemon-1", SessionID: "sess-9", Title: "调试登录页",
				AgentSyncID: "agent-1", ProjectSyncID: "proj-1", BackendType: "claude_code",
				LifecycleState: "waiting_for_input", WaitingForInput: true, LastMessageAt: 12345,
			}},
		}},
	}}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/agent-sessions?axis=agent", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Total  int64 `json:"total"`
		Groups []struct {
			Scope   string `json:"scope"`
			Total   int64  `json:"total"`
			Cursor  string `json:"cursor"`
			HasMore bool   `json:"has_more"`
			Items   []struct {
				PeerFingerprint string `json:"peer_fingerprint"`
				SessionID       string `json:"session_id"`
				Title           string `json:"title"`
				AgentSyncID     string `json:"agent_sync_id"`
				ProjectSyncID   string `json:"project_sync_id"`
				BackendType     string `json:"backend_type"`
				LifecycleState  string `json:"lifecycle_state"`
				WaitingForInput bool   `json:"waiting_for_input"`
				LastMessageAt   int64  `json:"last_message_at"`
			} `json:"items"`
		} `json:"groups"`
	}
	decodeEnvelope(t, resp, &got)
	assert.EqualValues(t, 137, got.Total)
	require.Len(t, got.Groups, 1)
	group := got.Groups[0]
	assert.Equal(t, "agent:agent-1", group.Scope)
	assert.EqualValues(t, 9, group.Total)
	assert.Equal(t, "1700.42", group.Cursor)
	assert.True(t, group.HasMore)
	require.Len(t, group.Items, 1)
	item := group.Items[0]
	assert.Equal(t, "fp-daemon-1", item.PeerFingerprint)
	assert.Equal(t, "sess-9", item.SessionID)
	assert.Equal(t, "调试登录页", item.Title)
	assert.Equal(t, "agent-1", item.AgentSyncID)
	assert.Equal(t, "proj-1", item.ProjectSyncID)
	assert.Equal(t, "claude_code", item.BackendType)
	assert.Equal(t, "waiting_for_input", item.LifecycleState)
	assert.True(t, item.WaitingForInput)
	assert.EqualValues(t, 12345, item.LastMessageAt)
	assert.EqualValues(t, 7, stub.indexInput.UserID)
	assert.Equal(t, workspace_svc.AxisAgent, stub.indexInput.Axis)
}

// 四组入参原样到达 service：轴、组、游标、两个大小、搜索词与筛选。控制器不判定
// 任何一样（夹取与合法性都在 service），因此这里盯的就是「一个都不能丢」。
func TestSavedSessions_PassesEveryQueryParamThrough(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+
		"/v1/agent-sessions?axis=project&scope=project%3Aproj-1&cursor=1700.42"+
		"&limit=20&per_group=3&q=%E7%99%BB%E5%BD%95&filter=waiting", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	assert.Equal(t, workspace_svc.AxisProject, stub.indexInput.Axis)
	assert.Equal(t, "project:proj-1", stub.indexInput.Scope)
	assert.Equal(t, "1700.42", stub.indexInput.Cursor)
	assert.Equal(t, 20, stub.indexInput.Limit)
	assert.Equal(t, 3, stub.indexInput.PerGroup)
	assert.Equal(t, "登录", stub.indexInput.Search)
	assert.Equal(t, workspace_svc.SessionFilterWaiting, stub.indexInput.Filter)
}

// 带 scope 时给的是这一组的行（不是组骨架），游标与 has_more 在顶层。
func TestSavedSessions_ScopedReadReturnsRowsAtTopLevel(t *testing.T) {
	stub := &stubWorkspaceSvc{index: workspace_svc.SessionIndexPage{
		Total: 9, Cursor: "1600.41", HasMore: true,
		Items: []workspace_svc.SavedSessionSummaryView{
			{PeerFingerprint: "fp-a", SessionID: "1"},
		},
	}}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/agent-sessions?axis=machine&scope=machine%3Afp-a", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Total   int64 `json:"total"`
		Cursor  string
		HasMore bool       `json:"has_more"`
		Groups  []struct{} `json:"groups"`
		Items   []struct {
			PeerFingerprint string `json:"peer_fingerprint"`
		} `json:"items"`
	}
	decodeEnvelope(t, resp, &got)
	assert.Empty(t, got.Groups)
	require.Len(t, got.Items, 1)
	assert.Equal(t, "fp-a", got.Items[0].PeerFingerprint)
	assert.True(t, got.HasMore)
	assert.EqualValues(t, 9, got.Total)
}

// 认不出来的轴 / 筛选值在绑定这一层就被拒，不会带着一个空轴走到 service。
func TestSavedSessions_RejectsUnknownAxisAndFilter(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	for _, query := range []string{"?axis=banana", "?filter=banana"} {
		resp := get(t, server.URL+"/v1/agent-sessions"+query, cookie.Value)
		assert.NotEqual(t, http.StatusOK, resp.StatusCode, "query %s 该被拒", query)
	}
}

// 未登录请求（无 cookie、无 Bearer）被 SessionOrDeviceAuth 拒绝。
func TestSavedSessions_UnauthenticatedRejected(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newMirrorTestServer(t, stub)

	resp := get(t, server.URL+"/v1/agent-sessions", "")
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 转录按游标翻页：请求里的 peer_fingerprint / session_id / cursor / limit 原样
// 到达 service，应答带回一页帧与新游标。
func TestTranscript_PagesByCursor(t *testing.T) {
	stub := &stubWorkspaceSvc{page: workspace_svc.TranscriptPage{
		Frames: []workspace_svc.TranscriptFrameView{
			{Seq: 6, Method: "session.notify", Params: json.RawMessage(`{"text":"hi"}`)},
		},
		Cursor: 6, HasMore: true,
	}}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/agent-sessions/transcript?peer_fingerprint=fp-daemon-1&session_id=sess-9&cursor=5&limit=1",
		cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Frames []struct {
			Seq    int64           `json:"seq"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		} `json:"frames"`
		Cursor  int64 `json:"cursor"`
		HasMore bool  `json:"has_more"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Frames, 1)
	assert.EqualValues(t, 6, got.Frames[0].Seq)
	assert.Equal(t, "session.notify", got.Frames[0].Method)
	assert.JSONEq(t, `{"text":"hi"}`, string(got.Frames[0].Params))
	assert.EqualValues(t, 6, got.Cursor)
	assert.True(t, got.HasMore)

	assert.Equal(t, "fp-daemon-1", stub.transcript.PeerFingerprint)
	assert.Equal(t, "sess-9", stub.transcript.SessionID)
	assert.EqualValues(t, 5, stub.transcript.AfterSeq)
	assert.Equal(t, 1, stub.transcript.Limit)
	assert.EqualValues(t, 7, stub.transcript.UserID)
}

// direction=backward 走反向读：cursor 改作**排他上界**送进 BeforeSeq，而不是
// AfterSeq —— 送错那一个，服务端会从这条对话的开头往后翻，正好相反。
// 应答上多出 oldest_seq / has_before 两列供往上翻。
func TestTranscript_BackwardReadsTheTail(t *testing.T) {
	stub := &stubWorkspaceSvc{page: workspace_svc.TranscriptPage{
		Frames: []workspace_svc.TranscriptFrameView{
			{Seq: 10, Method: "runtime.event", Params: json.RawMessage(`{"a":1}`)},
			{Seq: 12, Method: "runtime.event", Params: json.RawMessage(`{"a":2}`)},
		},
		Cursor: 12, OldestSeq: 10, HasBefore: true,
	}}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/agent-sessions/transcript?peer_fingerprint=fp-daemon-1"+
		"&session_id=sess-9&cursor=20&direction=backward", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Cursor    int64 `json:"cursor"`
		OldestSeq int64 `json:"oldest_seq"`
		HasBefore bool  `json:"has_before"`
		HasMore   bool  `json:"has_more"`
	}
	decodeEnvelope(t, resp, &got)
	assert.EqualValues(t, 12, got.Cursor, "cursor 在两个方向上同义：这一页最新那条")
	assert.EqualValues(t, 10, got.OldestSeq)
	assert.True(t, got.HasBefore)
	assert.False(t, got.HasMore, "has_more 只对正向有意义")

	assert.True(t, stub.transcript.Backward)
	assert.EqualValues(t, 20, stub.transcript.BeforeSeq)
	assert.Zero(t, stub.transcript.AfterSeq, "反向时 AfterSeq 不能被顺手填上")
}

// direction 缺省 = 正向，与今天逐字一致（这一条与既有 TestTranscript_PagesByCursor
// 一起把「没传 direction 的老调用方行为不变」钉住）。
func TestTranscript_DefaultDirectionStaysForward(t *testing.T) {
	stub := &stubWorkspaceSvc{page: workspace_svc.TranscriptPage{Cursor: 5}}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/agent-sessions/transcript?peer_fingerprint=fp-daemon-1&session_id=sess-9&cursor=5",
		cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.False(t, stub.transcript.Backward)
	assert.EqualValues(t, 5, stub.transcript.AfterSeq)
	assert.Zero(t, stub.transcript.BeforeSeq)
}

// 认不出的 direction 是错，不是「当成正向」：悄悄退回默认会让调用方以为自己拿到的
// 是尾巴，其实拿的是开头。
func TestTranscript_RejectsUnknownDirection(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/agent-sessions/transcript?peer_fingerprint=fp-daemon-1"+
		"&session_id=sess-9&direction=sideways", cookie.Value)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Zero(t, stub.transcript.UserID, "校验没过就不该走到 service")
}

// peer_fingerprint / session_id 缺失时请求校验直接拒绝，走不到 service。
func TestTranscript_RequiresPeerFingerprintAndSessionID(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newMirrorTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/agent-sessions/transcript", cookie.Value)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// ── 标记已读（2026-08-20 对话页 UI/UX 改版）─────────────────────────────────

// 身份键原样转给 service，账号取自会话而不是请求体；响应回落定的那个时刻，
// 供客户端就地覆盖那一行（刚打开的那条当场就该不再是未读）。
func TestMarkSessionRead_PassesIdentityThroughAndReturnsTheStampedTime(t *testing.T) {
	stub := &stubWorkspaceSvc{markReadAt: 1_700_000_000_123}
	server, _ := newMirrorTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/agent-sessions/read", cookie.Value, csrf,
		`{"peer_fingerprint":"fp-daemon-1","session_id":"sess-9"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		LastReadAt int64 `json:"last_read_at"`
	}
	decodeEnvelope(t, resp, &got)
	assert.EqualValues(t, 1_700_000_000_123, got.LastReadAt)
	assert.Equal(t, [3]string{"7", "fp-daemon-1", "sess-9"}, stub.markReadInput)
}

// 请求体里**没有**时刻这个字段：客户端的钟不可信，而这个时刻要跟服务端自己记的
// updated_at 相比。多传一个 last_read_at 也不会被采信。
func TestMarkSessionRead_IgnoresAnyClientSuppliedTime(t *testing.T) {
	stub := &stubWorkspaceSvc{markReadAt: 42}
	server, _ := newMirrorTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/agent-sessions/read", cookie.Value, csrf,
		`{"peer_fingerprint":"fp-daemon-1","session_id":"sess-9","last_read_at":999999}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		LastReadAt int64 `json:"last_read_at"`
	}
	decodeEnvelope(t, resp, &got)
	assert.EqualValues(t, 42, got.LastReadAt)
}

// 身份键缺一半在绑定这一层就被拒：少了指纹的「已读」不知道该记在哪条对话上。
func TestMarkSessionRead_RejectsMissingIdentity(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newMirrorTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	for _, body := range []string{
		`{"session_id":"sess-9"}`,
		`{"peer_fingerprint":"fp-daemon-1"}`,
	} {
		resp := postJSON(t, server.URL+"/v1/agent-sessions/read", cookie.Value, csrf, body)
		assert.NotEqual(t, http.StatusOK, resp.StatusCode, "body: %s", body)
	}
	assert.Equal(t, [3]string{}, stub.markReadInput)
}

func postJSON(t *testing.T, url, cookie, csrf, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf)
	req.AddCookie(&http.Cookie{Name: testCookieName, Value: cookie})
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// TestWaitingCount_CountsForTheAuthenticatedAccountOnly 守这条端点的账号作用域。
//
// 账号只由本组的鉴权圈定，请求里没有、也不该有任何身份参数：收一个 user_id 参数就是
// 把「数谁的对话」交给了调用方，而这条端点每次进任何页面都会被调到。
func TestWaitingCount_CountsForTheAuthenticatedAccountOnly(t *testing.T) {
	stub := &stubWorkspaceSvc{waitingCount: 3}
	server, _ := newMirrorTestServer(t, stub)

	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/agent-sessions/waiting-count", nil)
	require.NoError(t, err)
	req.AddCookie(newSessionCookie(t, 7))
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode, string(body))
	assert.Equal(t, int64(7), stub.waitingCountUserID)
	assert.Contains(t, string(body), `"waiting":3`)
}

// TestWaitingCount_ZeroIsAnAnswerNotAnOmission 守 0 说得出来。
//
// 侧栏那颗角标只在 > 0 时才画，所以 0 让它整个不出现 —— 那是对的。但字段必须**在**：
// 带 omitempty 的话，「没人等你」与「这次没问出来」在线上长得一模一样，而前端对这两种
// 情形该做的事不同。
func TestWaitingCount_ZeroIsAnAnswerNotAnOmission(t *testing.T) {
	stub := &stubWorkspaceSvc{waitingCount: 0}
	server, _ := newMirrorTestServer(t, stub)

	req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/agent-sessions/waiting-count", nil)
	require.NoError(t, err)
	req.AddCookie(newSessionCookie(t, 7))
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Contains(t, string(body), `"waiting":0`)
}
