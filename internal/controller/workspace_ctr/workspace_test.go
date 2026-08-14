package workspace_ctr_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"agentre-server/internal/api"
	"agentre-server/internal/bootstrap"
	"agentre-server/internal/pkg/code"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwt/testkeys"
	"agentre-server/internal/pkg/session"
	"agentre-server/internal/service/auth_svc"
	"agentre-server/internal/service/workspace_svc"
)

const testCookieName = "server_session"

// stubWorkspaceSvc 记下实际收到的入参，实现 workspace_svc.WorkspaceSvc。
type stubWorkspaceSvc struct {
	agents         []workspace_svc.AgentView
	detail         *workspace_svc.DeviceDetailView
	detailInputs   []int64
	detailErr      error
	listCalled     bool
	listFingerprnt string
	dispatchPlan   *workspace_svc.WebDispatchPlan
	dispatchInputs []string
	orderInputs    []workspace_svc.SetExecTargetOrderInput
	orderErr       error
}

func (s *stubWorkspaceSvc) ListAccountAgents(_ context.Context, _ int64, deviceFingerprint string) ([]workspace_svc.AgentView, error) {
	s.listCalled = true
	s.listFingerprnt = deviceFingerprint
	return s.agents, nil
}

func (s *stubWorkspaceSvc) WebDispatchPlan(_ context.Context, _ int64, agentSyncID, projectSyncID, deviceFingerprint string) (*workspace_svc.WebDispatchPlan, error) {
	s.dispatchInputs = append(s.dispatchInputs, agentSyncID, projectSyncID, deviceFingerprint)
	return s.dispatchPlan, nil
}

func (s *stubWorkspaceSvc) SetExecTargetOrder(_ context.Context, in workspace_svc.SetExecTargetOrderInput) error {
	s.orderInputs = append(s.orderInputs, in)
	return s.orderErr
}

// PurgeDeviceExecTargetOrders 没有对应的端点（撤销设备走 device_svc.Revoke），这里
// 只为满足接口——控制器不该有路可以调到它。
func (s *stubWorkspaceSvc) PurgeDeviceExecTargetOrders(context.Context, int64) error { return nil }

func (s *stubWorkspaceSvc) DeviceDetail(_ context.Context, _ int64, deviceID int64) (*workspace_svc.DeviceDetailView, error) {
	s.detailInputs = append(s.detailInputs, deviceID)
	if s.detailErr != nil {
		return nil, s.detailErr
	}
	return s.detail, nil
}

var _ workspace_svc.WorkspaceSvc = (*stubWorkspaceSvc)(nil)

func newWorkspaceTestServer(t *testing.T, stub *stubWorkspaceSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis()
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	workspace_svc.SetDefault(stub)
	t.Cleanup(func() { workspace_svc.SetDefault(workspace_svc.New()) })
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

// newSessionCookieWithCSRF 另外交出这次会话的 CSRF 令牌：凭 cookie 鉴权的写操作
// 必须出示它（见 middleware.SessionOrDeviceAuth）。
func newSessionCookieWithCSRF(t *testing.T, userID int64) (*http.Cookie, string) {
	t.Helper()
	sid, sess, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return &http.Cookie{Name: testCookieName, Value: sid}, sess.CSRFToken
}

// postJSON 发一次带 JSON 正文的写请求；cookie 为空即模拟未登录。
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

// 浏览器 session 登录的 web 端要能拿到总览页的账号级 Agent 清单，逐档带可用性
// 与「当前生效」标记。
func TestListAgents_WorksForBrowserSession(t *testing.T) {
	stub := &stubWorkspaceSvc{agents: []workspace_svc.AgentView{
		{
			SyncID: "agent-1", Name: "前端 Agent", DepartmentName: "工程",
			HasAvailableTarget: true,
			ExecTargets: []workspace_svc.ExecTargetView{
				{Rank: 1, IsLocalReference: true, Availability: workspace_svc.AvailabilitySkippedForWeb},
				{Rank: 2, DeviceID: 20, DeviceName: "书房小主机", BackendType: "claude_code",
					Availability: workspace_svc.AvailabilityAvailable, Current: true},
			},
		},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/agents", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.True(t, stub.listCalled)

	var got struct {
		Agents []struct {
			SyncID             string `json:"sync_id"`
			Name               string `json:"name"`
			DepartmentName     string `json:"department_name"`
			HasAvailableTarget bool   `json:"has_available_target"`
			ExecTargets        []struct {
				Rank             int    `json:"rank"`
				IsLocalReference bool   `json:"is_local_reference"`
				DeviceName       string `json:"device_name"`
				Availability     string `json:"availability"`
				Current          bool   `json:"current"`
			} `json:"exec_targets"`
		} `json:"agents"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Agents, 1)
	assert.Equal(t, "前端 Agent", got.Agents[0].Name)
	assert.True(t, got.Agents[0].HasAvailableTarget)
	require.Len(t, got.Agents[0].ExecTargets, 2)
	assert.True(t, got.Agents[0].ExecTargets[0].IsLocalReference)
	assert.Equal(t, "skipped_for_web", got.Agents[0].ExecTargets[0].Availability)
	assert.True(t, got.Agents[0].ExecTargets[1].Current)
	assert.Equal(t, "书房小主机", got.Agents[0].ExecTargets[1].DeviceName)
}

// 未登录（无 cookie、无 device JWT）必须被拒绝——这条端点不是公开的。
func TestListAgents_RejectsUnauthenticated(t *testing.T) {
	server, _ := newWorkspaceTestServer(t, &stubWorkspaceSvc{})
	resp := get(t, server.URL+"/v1/workspace/agents", "")
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 设备详情端点把 query 里的 device_id 原样转给 service，并把 agentred 的
// 「能跑的 Agent」与「项目」透传回去。
func TestDeviceDetail_WorksForBrowserSession_WithDeviceIDQuery(t *testing.T) {
	stub := &stubWorkspaceSvc{detail: &workspace_svc.DeviceDetailView{
		DeviceID: 20, Kind: "agentred",
		RunnableAgents: []workspace_svc.RunnableAgentView{{SyncID: "agent-1", Name: "前端 Agent", Rank: 2}},
		Projects:       []workspace_svc.ProjectView{{SyncID: "proj-1", Name: "agentre-server", Configured: true}},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/device-detail?device_id=20", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, []int64{20}, stub.detailInputs)

	var got struct {
		Kind           string `json:"kind"`
		RunnableAgents []struct {
			Name string `json:"name"`
			Rank int    `json:"rank"`
		} `json:"runnable_agents"`
		Projects []struct {
			Name       string `json:"name"`
			Configured bool   `json:"configured"`
		} `json:"projects"`
	}
	decodeEnvelope(t, resp, &got)
	assert.Equal(t, "agentred", got.Kind)
	require.Len(t, got.RunnableAgents, 1)
	assert.Equal(t, 2, got.RunnableAgents[0].Rank)
	require.Len(t, got.Projects, 1)
	assert.True(t, got.Projects[0].Configured)
}

// R15 派发计划端点：query 里的 agent_sync_id / project_sync_id 原样转给 service，
// 逐档原因、选中档与项目清单透传回浏览器。
func TestDispatchTarget_WorksForBrowserSession_WithAgentAndProject(t *testing.T) {
	stub := &stubWorkspaceSvc{dispatchPlan: &workspace_svc.WebDispatchPlan{
		AgentSyncID: "agent-1",
		Tiers: []workspace_svc.WebDispatchTier{
			{Rank: 1, Availability: workspace_svc.AvailabilitySkippedForWeb},
			{Rank: 2, DeviceID: 21, DeviceName: "公司 Mac mini", BackendType: "codex",
				Availability: workspace_svc.AvailabilityAvailable, Current: true},
		},
		Chosen: &workspace_svc.WebDispatchChoice{
			DeviceFingerprint: "fp-online", DeviceID: 21, DeviceName: "公司 Mac mini",
			BackendType: "codex", Cwd: "/srv/agentre-server",
		},
		Projects: []workspace_svc.ProjectView{{SyncID: "proj-1", Name: "agentre-server", Configured: true}},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/dispatch-target?agent_sync_id=agent-1&project_sync_id=proj-1", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, []string{"agent-1", "proj-1", ""}, stub.dispatchInputs)

	var got struct {
		AgentSyncID string `json:"agent_sync_id"`
		Tiers       []struct {
			Rank         int    `json:"rank"`
			DeviceName   string `json:"device_name"`
			Availability string `json:"availability"`
			Current      bool   `json:"current"`
		} `json:"tiers"`
		Chosen *struct {
			DeviceFingerprint string `json:"device_fingerprint"`
			DeviceName        string `json:"device_name"`
			Cwd               string `json:"cwd"`
		} `json:"chosen"`
		Projects []struct {
			SyncID string `json:"sync_id"`
			Name   string `json:"name"`
		} `json:"projects"`
	}
	decodeEnvelope(t, resp, &got)
	assert.Equal(t, "agent-1", got.AgentSyncID)
	require.Len(t, got.Tiers, 2)
	assert.Equal(t, "skipped_for_web", got.Tiers[0].Availability)
	assert.True(t, got.Tiers[1].Current)
	require.NotNil(t, got.Chosen)
	assert.Equal(t, "fp-online", got.Chosen.DeviceFingerprint)
	assert.Equal(t, "/srv/agentre-server", got.Chosen.Cwd)
	require.Len(t, got.Projects, 1)
	assert.Equal(t, "proj-1", got.Projects[0].SyncID)
}

// 未登录（无 cookie、无 device JWT）必须被拒绝——派发计划不是公开端点。
func TestDispatchTarget_RejectsUnauthenticated(t *testing.T) {
	server, _ := newWorkspaceTestServer(t, &stubWorkspaceSvc{})
	resp := get(t, server.URL+"/v1/workspace/dispatch-target?agent_sync_id=agent-1", "")
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// 不属于自己账号 / 不存在的设备：service 报 NotFound，controller 原样透传，
// 不吞成 500、也不悄悄返回空详情。
//
// 断言必须落到**业务码**上。只断言「状态码不是 200」时，controller 把 NotFound
// 吞成 500 一样能过——那正是这段注释禁止的那一种。
func TestDeviceDetail_PropagatesNotFoundFromService(t *testing.T) {
	stub := &stubWorkspaceSvc{
		detailErr: i18n.NewNotFoundError(context.Background(), code.DeviceNotFound),
	}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/device-detail?device_id=99", cookie.Value)

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(body, &envelope))
	assert.Equal(t, code.DeviceNotFound, envelope.Code)
	assert.Empty(t, envelope.Data)
}

// ── 每端自己的派发顺序 ────────────────────────────────────────────────

// 这组端点鉴权的是**用户**不是设备，所以调用方自己的设备指纹只能由参数传入：
// query 里的 device_fingerprint 要原样转给 service，否则浏览器永远拿到账号顺序。
// 逐档的 backend_sync_id 也要透传——浏览器只能靠它表达排列。
func TestDispatchTarget_PassesCallerDeviceFingerprintAndCarriesBackendSyncID(t *testing.T) {
	stub := &stubWorkspaceSvc{dispatchPlan: &workspace_svc.WebDispatchPlan{
		AgentSyncID: "agent-1",
		Tiers: []workspace_svc.WebDispatchTier{
			{Rank: 1, BackendSyncID: "b-c", DeviceID: 22, DeviceName: "机器 C",
				Availability: workspace_svc.AvailabilityAvailable, Current: true},
			{Rank: 2, BackendSyncID: "b-a", DeviceID: 20, DeviceName: "机器 A",
				Availability: workspace_svc.AvailabilityOffline},
		},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/dispatch-target?agent_sync_id=agent-1&device_fingerprint=fp-web", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, []string{"agent-1", "", "fp-web"}, stub.dispatchInputs)

	var got struct {
		Tiers []struct {
			BackendSyncID string `json:"backend_sync_id"`
			Current       bool   `json:"current"`
		} `json:"tiers"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Tiers, 2)
	assert.Equal(t, "b-c", got.Tiers[0].BackendSyncID)
	assert.True(t, got.Tiers[0].Current)
	assert.Equal(t, "b-a", got.Tiers[1].BackendSyncID)
}

// 总览页的卡片链同理：指纹转给 service，逐档带 backend_sync_id。
func TestListAgents_PassesCallerDeviceFingerprintAndCarriesBackendSyncID(t *testing.T) {
	stub := &stubWorkspaceSvc{agents: []workspace_svc.AgentView{{
		SyncID: "agent-1", Name: "后端 Agent", HasAvailableTarget: true,
		ExecTargets: []workspace_svc.ExecTargetView{
			{Rank: 1, BackendSyncID: "b-c", DeviceName: "机器 C",
				Availability: workspace_svc.AvailabilityAvailable, Current: true},
		},
	}}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/agents?device_fingerprint=fp-web", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "fp-web", stub.listFingerprnt)

	var got struct {
		Agents []struct {
			ExecTargets []struct {
				BackendSyncID string `json:"backend_sync_id"`
			} `json:"exec_targets"`
		} `json:"agents"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Agents, 1)
	require.Len(t, got.Agents[0].ExecTargets, 1)
	assert.Equal(t, "b-c", got.Agents[0].ExecTargets[0].BackendSyncID)
}

// 写端点：账号取自鉴权上下文，设备指纹 / Agent / 排列取自请求体，原样转给 service。
func TestSetExecTargetOrder_PassesFingerprintAgentAndPermutation(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", cookie.Value, csrf,
		`{"device_fingerprint":"fp-web-0001","agent_sync_id":"agent-1","backend_sync_ids":["b-c","b-a"]}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orderInputs, 1)
	assert.Equal(t, int64(7), stub.orderInputs[0].UserID)
	assert.Equal(t, "fp-web-0001", stub.orderInputs[0].DeviceFingerprint)
	assert.Equal(t, "agent-1", stub.orderInputs[0].AgentSyncID)
	assert.Equal(t, []string{"b-c", "b-a"}, stub.orderInputs[0].BackendSyncIDs)
}

// 决策 9：传入的设备指纹解析不到调用方账号下的设备时，service 拒绝，controller 原样
// 透传——不吞成 500、更不当作成功。断言必须落到**业务码**上：只断言「不是 200」时，
// 把 NotFound 吞成 500 一样能过。
func TestSetExecTargetOrder_PropagatesRejectionForForeignDevice(t *testing.T) {
	stub := &stubWorkspaceSvc{
		orderErr: i18n.NewNotFoundError(context.Background(), code.DeviceNotFound),
	}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", cookie.Value, csrf,
		`{"device_fingerprint":"fp-someone-else","agent_sync_id":"agent-1","backend_sync_ids":["b-c"]}`)

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(body, &envelope))
	assert.Equal(t, code.DeviceNotFound, envelope.Code)
}

// 未登录（无 cookie、无 device JWT）不得写任何人的顺序。
func TestSetExecTargetOrder_RejectsUnauthenticated(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", "", "",
		`{"device_fingerprint":"fp-web-0001","agent_sync_id":"agent-1","backend_sync_ids":["b-c"]}`)

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Empty(t, stub.orderInputs)
}

// 排列的长度上限挡在绑定层：order_json 是 text（64 KB），65 档 × 255 字符的排列
// 已经越界。超限的请求必须被拒，且一步都不许走到 service——只验 happy path 的话，
// 把 max=64 写在 dive 之后（于是它变成「每个元素最长 64」）也照样绿。
func TestSetExecTargetOrder_RejectsOversizedPermutation(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	ids := make([]string, 65)
	for i := range ids {
		ids[i] = strings.Repeat("b", 200)
	}
	body, err := json.Marshal(map[string]any{
		"device_fingerprint": "fp-web-0001", "agent_sync_id": "agent-1", "backend_sync_ids": ids,
	})
	require.NoError(t, err)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", cookie.Value, csrf, string(body))

	assert.NotEqual(t, http.StatusOK, resp.StatusCode)
	assert.Empty(t, stub.orderInputs, "越界的排列不得走到 service")
}
