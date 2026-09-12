package sessionimport_ctr_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/sessionimport_svc"
)

const testCookieName = "server_session"

// stubImportSvc 记下实际收到的入参，实现 sessionimport_svc.SessionImportSvc。
type stubImportSvc struct {
	candidates   *sessionimport_svc.CandidatesView
	candidatesIn []sessionimport_svc.ListCandidatesInput
	preview      *sessionimport_svc.PreviewView
	previewIn    []sessionimport_svc.PreviewInput
	imported     *sessionimport_svc.ImportResultView
	importIn     []sessionimport_svc.ImportInput
	err          error
}

// 浏览器这次铸的号，与库里那条早就存在的号：导入路径允许交回后者（幂等收敛）。
const (
	mintedConversationID = "3f2d1b7a-5c44-7a10-9e3b-6a1f0c2d4e88"
	storedConversationID = "5b8c9d2e-1f30-7c55-b214-9d7e3a6b0c11"
)

func (s *stubImportSvc) ListCandidates(
	_ context.Context, in sessionimport_svc.ListCandidatesInput,
) (*sessionimport_svc.CandidatesView, error) {
	s.candidatesIn = append(s.candidatesIn, in)
	return s.candidates, s.err
}

func (s *stubImportSvc) Preview(
	_ context.Context, in sessionimport_svc.PreviewInput,
) (*sessionimport_svc.PreviewView, error) {
	s.previewIn = append(s.previewIn, in)
	return s.preview, s.err
}

func (s *stubImportSvc) Import(
	_ context.Context, in sessionimport_svc.ImportInput,
) (*sessionimport_svc.ImportResultView, error) {
	s.importIn = append(s.importIn, in)
	return s.imported, s.err
}

func newTestServer(t *testing.T, stub *stubImportSvc) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	sessionimport_svc.SetDefault(stub)
	t.Cleanup(func() { sessionimport_svc.SetDefault(nil) })
	auth_svc.SetDefault(auth_svc.New(redis.Default(), session.New(redis.Default(), testCookieName, 86400)))

	testMux := muxtest.NewTestMux()
	require.NoError(t, (&api.RouterDeps{
		Cfg:    &bootstrap.ServerConfig{RateLimit: bootstrap.RLConfig{AuthorizePerIPPerMin: 100}},
		Signer: signer,
	}).Router(context.Background(), testMux.Router))
	server := httptest.NewServer(testMux.IRouter.(*gin.Engine))
	t.Cleanup(server.Close)
	return server
}

func newSession(t *testing.T, userID int64) (string, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return sid, sess.CSRFToken
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

func postJSON(t *testing.T, url, cookie, csrf, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	require.NoError(t, err)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: testCookieName, Value: cookie})
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	req.Header.Set("Content-Type", "application/json")
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

// 浏览器登录后能列一台机器上的候选：两维筛选原样转给 service，账号取自鉴权上下文
// 而不是请求参数。答不出的那一档随清单一起回去，不是一个错误码。
func TestCandidates_ForwardsFiltersAndKeepsIssuesStructured(t *testing.T) {
	stub := &stubImportSvc{candidates: &sessionimport_svc.CandidatesView{
		Candidates: []sessionimport_svc.CandidateView{{
			Backend: "claudecode", ProviderSessionID: "prov-1", Title: "写个爬虫",
			Cwd: "/repos/spider", Locator: "loc-1", Turns: 12,
		}},
		Issues: []sessionimport_svc.ScanIssueView{{
			Status: sessionimport_svc.StatusUnavailable, Reason: "机器不在线",
		}},
	}}
	server := newTestServer(t, stub)
	cookie, _ := newSession(t, 7)

	resp := get(t, server.URL+
		"/v1/session-import/candidates?device_id=11&backends=claudecode,codex&cwd_prefix=/repos&title_query=爬",
		cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.candidatesIn, 1)
	in := stub.candidatesIn[0]
	assert.Equal(t, int64(7), in.UserID, "账号取自鉴权上下文，不取请求参数")
	assert.Equal(t, int64(11), in.DeviceID)
	assert.Equal(t, []string{"claudecode", "codex"}, in.Backends)
	assert.Equal(t, "/repos", in.CwdPrefix)
	assert.Equal(t, "爬", in.TitleQuery)

	var got struct {
		Candidates []struct {
			ProviderSessionID string `json:"provider_session_id"`
			Cwd               string `json:"cwd"`
			Locator           string `json:"locator"`
		} `json:"candidates"`
		Issues []struct {
			Backend string `json:"backend"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
		} `json:"issues"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Candidates, 1)
	assert.Equal(t, "/repos/spider", got.Candidates[0].Cwd)
	assert.Equal(t, "loc-1", got.Candidates[0].Locator)
	require.Len(t, got.Issues, 1)
	assert.Empty(t, got.Issues[0].Backend, "设备级的一档不挂在任何后端上")
	assert.Equal(t, "unavailable", got.Issues[0].Status)
}

// 预览的帧与账号镜像那条转录端点逐字段同形：params 原样过去，浏览器喂进同一个
// 归约器。改成别的形状就要在前端另开一条渲染链。
func TestPreview_ReturnsFramesShapedLikeTheMirrorTranscript(t *testing.T) {
	stub := &stubImportSvc{preview: &sessionimport_svc.PreviewView{
		Meta: sessionimport_svc.MetaView{
			Backend: "claudecode", ProviderSessionID: "prov-1", Cwd: "/repos/spider",
			Gaps: []sessionimport_svc.GapView{{Kind: "encrypted_thinking", Count: 3}},
		},
		Frames: []sessionimport_svc.FrameView{{
			Seq: 1, Method: "runtime.event",
			Params: json.RawMessage(`{"sessionId":0,"event":{"kind":"user_message","text":"你好"}}`),
		}},
		PreviewedTurns: 1, RemainingTurns: -1,
	}}
	server := newTestServer(t, stub)
	cookie, _ := newSession(t, 7)

	resp := get(t, server.URL+
		"/v1/session-import/preview?device_id=11&backend=claudecode&locator=loc-1&turns=2", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Len(t, stub.previewIn, 1)
	assert.Equal(t, 2, stub.previewIn[0].Turns)
	assert.Equal(t, "loc-1", stub.previewIn[0].Locator)

	var got struct {
		Meta struct {
			ProviderSessionID string `json:"provider_session_id"`
			Gaps              []struct {
				Kind  string `json:"kind"`
				Count int    `json:"count"`
			} `json:"gaps"`
		} `json:"meta"`
		Frames []struct {
			Seq    int64           `json:"seq"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		} `json:"frames"`
		RemainingTurns int `json:"remaining_turns"`
	}
	decodeEnvelope(t, resp, &got)
	assert.Equal(t, "prov-1", got.Meta.ProviderSessionID)
	require.Len(t, got.Meta.Gaps, 1)
	require.Len(t, got.Frames, 1)
	assert.Equal(t, "runtime.event", got.Frames[0].Method)
	assert.JSONEq(t, `{"sessionId":0,"event":{"kind":"user_message","text":"你好"}}`,
		string(got.Frames[0].Params))
	assert.Equal(t, -1, got.RemainingTurns, "「说不出还剩几轮」必须原样过去，不是 0")
}

// 执行导入是写方法：浏览器铸的 conversation_id 原样转给 service，回执带回**这条
// 对话的身份**——已经导过时它是库里那条的标识，未必等于这次铸的号。
func TestRun_ForwardsTheMintedConversationIDAndReturnsTheStoredOne(t *testing.T) {
	stub := &stubImportSvc{imported: &sessionimport_svc.ImportResultView{
		ConversationID: storedConversationID, PeerFingerprint: "sha256:aaaa", Cwd: "/repos/spider",
		Title: "写个爬虫", ImportedTurns: 12,
	}}
	server := newTestServer(t, stub)
	cookie, csrf := newSession(t, 7)

	resp := postJSON(t, server.URL+"/v1/session-import/run", cookie, csrf,
		`{"device_id":11,"backend":"claudecode","locator":"loc-1","conversation_id":"`+
			mintedConversationID+`","agent_sync_id":"agent-1"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.importIn, 1)
	assert.Equal(t, mintedConversationID, stub.importIn[0].ConversationID)
	assert.Equal(t, "agent-1", stub.importIn[0].AgentSyncID)
	assert.Equal(t, int64(7), stub.importIn[0].UserID)

	var got struct {
		ConversationID  string `json:"conversation_id"`
		PeerFingerprint string `json:"peer_fingerprint"`
		ImportedTurns   int    `json:"imported_turns"`
	}
	decodeEnvelope(t, resp, &got)
	assert.Equal(t, storedConversationID, got.ConversationID,
		"交回的是库里那条的标识，不是这次送进去的那个")
	assert.Equal(t, "sha256:aaaa", got.PeerFingerprint)
	assert.Equal(t, 12, got.ImportedTurns)
}

// 没登录一律拒：磁盘转录是账号里最私密的一类东西，这三个端点都不接受匿名调用。
func TestSessionImport_WithoutASession_IsRefused(t *testing.T) {
	stub := &stubImportSvc{candidates: &sessionimport_svc.CandidatesView{}}
	server := newTestServer(t, stub)

	resp := get(t, server.URL+"/v1/session-import/candidates?device_id=11", "")

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Empty(t, stub.candidatesIn, "service 一次都不该被调到")
}

// 铸号是浏览器的事，但给不出身份、或给一个旧的整数会话号，在那台机器上都建不出
// 对话：绑定层就地拒掉，不到 service。
func TestRun_WithoutACanonicalConversationID_IsRejectedAtBinding(t *testing.T) {
	stub := &stubImportSvc{imported: &sessionimport_svc.ImportResultView{}}
	server := newTestServer(t, stub)
	cookie, csrf := newSession(t, 7)

	for _, body := range []string{
		`{"device_id":11,"backend":"claudecode","locator":"loc-1"}`,
		`{"device_id":11,"backend":"claudecode","locator":"loc-1","conversation_id":"4242"}`,
	} {
		resp := postJSON(t, server.URL+"/v1/session-import/run", cookie, csrf, body)
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "body: %s", body)
	}
	assert.Empty(t, stub.importIn)
}
