package workspace_ctr_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/cago-frame/cago/server/mux/muxtest"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/testutils"

	"github.com/agentre-hub/agentre-server/internal/api"
	"github.com/agentre-hub/agentre-server/internal/bootstrap"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt/testkeys"
	"github.com/agentre-hub/agentre-server/internal/pkg/session"
	"github.com/agentre-hub/agentre-server/internal/service/auth_svc"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

const testCookieName = "server_session"

// stubWorkspaceSvc 记下实际收到的入参，实现 workspace_svc.WorkspaceSvc。
type stubWorkspaceSvc struct {
	agents         []workspace_svc.AgentView
	detail         *workspace_svc.DeviceDetailView
	detailInputs   []int64
	detailErr      error
	listCalled     bool
	dispatchPlan   *workspace_svc.WebDispatchPlan
	dispatchIn     []workspace_svc.WebDispatchPlanInput
	dispatchInputs []string
	orderInputs    []workspace_svc.SetExecTargetOrderInput
	orderErr       error
	projects       []workspace_svc.ProjectNodeView
	machines       []workspace_svc.ProjectMachineView
	machineInputs  []string
	machineErr     error
	locationInputs []workspace_svc.SetProjectLocationInput
	locationErr    error
	orgOps         []string
	orgInputs      []workspace_svc.OrgWriteInput
	orgErr         error
	orgChart       *workspace_svc.OrgChartView
	orgChartInputs []int64
	backends       []workspace_svc.OrgBackendView
	backendsInputs []int64
}

func (s *stubWorkspaceSvc) OrgChart(_ context.Context, userID int64) (*workspace_svc.OrgChartView, error) {
	s.orgChartInputs = append(s.orgChartInputs, userID)
	if s.orgChart == nil {
		return &workspace_svc.OrgChartView{}, nil
	}
	return s.orgChart, nil
}

func (s *stubWorkspaceSvc) SelectableBackends(
	_ context.Context, userID int64,
) ([]workspace_svc.OrgBackendView, error) {
	s.backendsInputs = append(s.backendsInputs, userID)
	return s.backends, nil
}

func (s *stubWorkspaceSvc) ListAccountAgents(_ context.Context, _ int64) ([]workspace_svc.AgentView, error) {
	s.listCalled = true
	return s.agents, nil
}

func (s *stubWorkspaceSvc) WebDispatchPlan(_ context.Context, in workspace_svc.WebDispatchPlanInput) (*workspace_svc.WebDispatchPlan, error) {
	s.dispatchInputs = append(s.dispatchInputs, in.AgentSyncID, in.ProjectSyncID)
	s.dispatchIn = append(s.dispatchIn, in)
	return s.dispatchPlan, nil
}

func (s *stubWorkspaceSvc) SetExecTargetOrder(_ context.Context, in workspace_svc.SetExecTargetOrderInput) error {
	s.orderInputs = append(s.orderInputs, in)
	return s.orderErr
}

func (s *stubWorkspaceSvc) DeviceDetail(_ context.Context, _ int64, deviceID int64) (*workspace_svc.DeviceDetailView, error) {
	s.detailInputs = append(s.detailInputs, deviceID)
	if s.detailErr != nil {
		return nil, s.detailErr
	}
	return s.detail, nil
}

func (s *stubWorkspaceSvc) AccountProjects(_ context.Context, _ int64) ([]workspace_svc.ProjectNodeView, error) {
	return s.projects, nil
}

func (s *stubWorkspaceSvc) ProjectMachines(
	_ context.Context, userID int64, projectSyncID string,
) ([]workspace_svc.ProjectMachineView, error) {
	s.machineInputs = append(s.machineInputs,
		fmt.Sprintf("%d:%s", userID, projectSyncID))
	if s.machineErr != nil {
		return nil, s.machineErr
	}
	return s.machines, nil
}

func (s *stubWorkspaceSvc) SetProjectLocation(
	_ context.Context, in workspace_svc.SetProjectLocationInput,
) (*workspace_svc.OrgWriteResult, error) {
	s.locationInputs = append(s.locationInputs, in)
	if s.locationErr != nil {
		return nil, s.locationErr
	}
	return &workspace_svc.OrgWriteResult{SyncID: "pl-written", Version: 43}, nil
}

func (s *stubWorkspaceSvc) SessionIndex(
	_ context.Context, _ workspace_svc.SessionIndexQuery,
) (workspace_svc.SessionIndexPage, error) {
	panic("not used by workspace_ctr tests: covered by agent_session_ctr's own suite")
}

func (s *stubWorkspaceSvc) MarkSessionRead(
	_ context.Context, _ int64, _, _ string,
) (int64, error) {
	panic("not used by workspace_ctr tests: covered by agent_session_ctr's own suite")
}

func (s *stubWorkspaceSvc) Transcript(
	_ context.Context, _ workspace_svc.TranscriptQuery,
) (workspace_svc.TranscriptPage, error) {
	panic("not used by workspace_ctr tests: covered by agent_session_ctr's own suite")
}

// 组织面写通道：记下每一次调用是哪个动作、带着什么入参，controller 测试据此断言
// 账号来自鉴权上下文、只有请求真的提到的键被送下去。
func (s *stubWorkspaceSvc) CreateOrgObject(
	_ context.Context, in workspace_svc.OrgWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	return s.recordOrgWrite("create", in)
}

func (s *stubWorkspaceSvc) UpdateOrgObject(
	_ context.Context, in workspace_svc.OrgWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	return s.recordOrgWrite("update", in)
}

func (s *stubWorkspaceSvc) DeleteOrgObject(
	_ context.Context, in workspace_svc.OrgWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	return s.recordOrgWrite("delete", in)
}

func (s *stubWorkspaceSvc) recordOrgWrite(
	op string, in workspace_svc.OrgWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	s.orgOps = append(s.orgOps, op)
	s.orgInputs = append(s.orgInputs, in)
	if s.orgErr != nil {
		return nil, s.orgErr
	}
	return &workspace_svc.OrgWriteResult{SyncID: "written-1", Version: 42}, nil
}

var _ workspace_svc.WorkspaceSvc = (*stubWorkspaceSvc)(nil)

func newWorkspaceTestServer(t *testing.T, stub *stubWorkspaceSvc) (*httptest.Server, *jwt.Signer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	testutils.Redis(t)
	signer, err := jwt.NewSigner(testkeys.PrivatePEM, testkeys.PublicPEM, "agentre-server", "agentre")
	require.NoError(t, err)
	workspace_svc.SetDefault(stub)
	t.Cleanup(func() { workspace_svc.SetDefault(workspace_svc.New()) })
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
				{Rank: 1, IsLocalReference: true, Availability: workspace_svc.AvailabilityNoDevice},
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
	assert.Equal(t, "no_device", got.Agents[0].ExecTargets[0].Availability)
	assert.True(t, got.Agents[0].ExecTargets[1].Current)
	assert.Equal(t, "书房小主机", got.Agents[0].ExecTargets[1].DeviceName)
}

// 「从项目里挑一个 Agent」要的两样透传出去：Agent 图标与它直接加入的项目。
// 一个 Agent 没加入任何项目时 project_sync_ids 必须**缺席**（omitempty），不发
// 一个空数组——浏览器那侧「没有成员关系」与「后端还没实现这一档」得分得开。
func TestListAgents_CarriesAvatarIconAndDirectProjects(t *testing.T) {
	stub := &stubWorkspaceSvc{agents: []workspace_svc.AgentView{
		{SyncID: "agent-1", Name: "后端 Agent", AvatarColor: "agent-1", AvatarIcon: "server-cog",
			ProjectSyncIDs: []string{"proj-a", "proj-b"}, HasAvailableTarget: true},
		{SyncID: "agent-2", Name: "文档 Agent", AvatarColor: "agent-11"},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/agents", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Agents []struct {
			SyncID         string   `json:"sync_id"`
			AvatarIcon     string   `json:"avatar_icon"`
			ProjectSyncIDs []string `json:"project_sync_ids"`
		} `json:"agents"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Agents, 2)
	assert.Equal(t, "server-cog", got.Agents[0].AvatarIcon)
	assert.Equal(t, []string{"proj-a", "proj-b"}, got.Agents[0].ProjectSyncIDs)
	assert.Empty(t, got.Agents[1].AvatarIcon)
	assert.Empty(t, got.Agents[1].ProjectSyncIDs)
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

// 「改在哪跑」：query 里的 target_backend_sync_id 必须原样转给 service。转丢了
// 不会报错，只会静默回落成「按序第一个可用」——用户挑了 B 机，活派到了 A 机上。
func TestDispatchTarget_ForwardsTargetBackendSyncID(t *testing.T) {
	stub := &stubWorkspaceSvc{dispatchPlan: &workspace_svc.WebDispatchPlan{AgentSyncID: "agent-1"}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+
		"/v1/workspace/dispatch-target?agent_sync_id=agent-1&project_sync_id=proj-1&target_backend_sync_id=b-b",
		cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.dispatchIn, 1)
	assert.Equal(t, "agent-1", stub.dispatchIn[0].AgentSyncID)
	assert.Equal(t, "proj-1", stub.dispatchIn[0].ProjectSyncID)
	assert.Equal(t, "b-b", stub.dispatchIn[0].TargetBackendSyncID)
	assert.Equal(t, int64(7), stub.dispatchIn[0].UserID, "账号取自鉴权上下文，不取请求体")
}

// 不带 target_backend_sync_id 时行为与从前一字不差：service 收到空串，
// 由它按「第一个可用」挑。
func TestDispatchTarget_WithoutTargetBackend_LeavesItEmpty(t *testing.T) {
	stub := &stubWorkspaceSvc{dispatchPlan: &workspace_svc.WebDispatchPlan{AgentSyncID: "agent-1"}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/dispatch-target?agent_sync_id=agent-1", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	require.Len(t, stub.dispatchIn, 1)
	assert.Empty(t, stub.dispatchIn[0].TargetBackendSyncID)
}

// R15 派发计划端点：query 里的 agent_sync_id / project_sync_id 原样转给 service，
// 逐档原因、选中档与项目清单透传回浏览器。
func TestDispatchTarget_WorksForBrowserSession_WithAgentAndProject(t *testing.T) {
	stub := &stubWorkspaceSvc{dispatchPlan: &workspace_svc.WebDispatchPlan{
		AgentSyncID: "agent-1",
		Tiers: []workspace_svc.WebDispatchTier{
			{Rank: 1, Availability: workspace_svc.AvailabilityNoDevice},
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
	assert.Equal(t, []string{"agent-1", "proj-1"}, stub.dispatchInputs)

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
	assert.Equal(t, "no_device", got.Tiers[0].Availability)
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

// ── 执行目标顺序 ────────────────────────────────────────────────────

// 逐档的 backend_sync_id 要透传——浏览器只能靠它指名要移动哪一档。调用方是哪个
// 浏览器不再进入任何一条路径（决策 14：顺序是账号级的，没有按浏览器区分的那一层）。
func TestDispatchTarget_CarriesBackendSyncIDPerTier(t *testing.T) {
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

	resp := get(t, server.URL+"/v1/workspace/dispatch-target?agent_sync_id=agent-1", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, []string{"agent-1", ""}, stub.dispatchInputs)

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

// 总览页的卡片链同理：逐档带 backend_sync_id。
func TestListAgents_CarriesBackendSyncIDPerTier(t *testing.T) {
	stub := &stubWorkspaceSvc{agents: []workspace_svc.AgentView{{
		SyncID: "agent-1", Name: "后端 Agent", HasAvailableTarget: true,
		ExecTargets: []workspace_svc.ExecTargetView{
			{Rank: 1, BackendSyncID: "b-c", DeviceName: "机器 C",
				Availability: workspace_svc.AvailabilityAvailable, Current: true},
		},
	}}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/agents", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

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

// 写端点：账号取自鉴权上下文，Agent 与排列取自请求体，原样转给 service。
func TestSetExecTargetOrder_PassesAgentAndPermutation(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", cookie.Value, csrf,
		`{"agent_sync_id":"agent-1","backend_sync_ids":["b-c","b-a"]}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orderInputs, 1)
	assert.Equal(t, int64(7), stub.orderInputs[0].UserID)
	assert.Equal(t, "agent-1", stub.orderInputs[0].AgentSyncID)
	assert.Equal(t, []string{"b-c", "b-a"}, stub.orderInputs[0].BackendSyncIDs)
}

// 保存失败（落库出错）必须以失败回到浏览器。这条端点的响应体是空的，成功与被吞掉的
// 失败在正文上长得一模一样，所以只有「码不是 0」能把两者分开：断言落到**业务码**上，
// 只断言「状态码不是 200」时，controller 把错误直接扔掉返回空成功一样能过。
func TestSetExecTargetOrder_PropagatesServiceFailureInsteadOfEmptySuccess(t *testing.T) {
	stub := &stubWorkspaceSvc{orderErr: errors.New("save exec target order failed")}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", cookie.Value, csrf,
		`{"agent_sync_id":"agent-1","backend_sync_ids":["b-c"]}`)

	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(body, &envelope))
	assert.NotEqual(t, 0, envelope.Code, "吞掉错误返回空成功时正文与成功不可分辨")
	assert.Empty(t, envelope.Data)
	require.Len(t, stub.orderInputs, 1, "失败的这一次仍然应当走到 service")
}

// 未登录（无 cookie、无 device JWT）不得写任何人的顺序。
func TestSetExecTargetOrder_RejectsUnauthenticated(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", "", "",
		`{"agent_sync_id":"agent-1","backend_sync_ids":["b-c"]}`)

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Empty(t, stub.orderInputs)
}

// 排列的长度上限挡在绑定层：一个 Agent 挂 65 档执行目标已经远超任何真实配置，
// 而写路径会拿这份排列去逐行读-改-写同步对象，长度不设限等于把写放大量交给调用方。
// 超限的请求必须被拒，且一步都不许走到 service——只验 happy path 的话，把 max=64
// 写在 dive 之后（于是它变成「每个元素最长 64」）也照样绿。
func TestSetExecTargetOrder_RejectsOversizedPermutation(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	ids := make([]string, 65)
	for i := range ids {
		ids[i] = strings.Repeat("b", 200)
	}
	body, err := json.Marshal(map[string]any{
		"agent_sync_id": "agent-1", "backend_sync_ids": ids,
	})
	require.NoError(t, err)

	resp := postJSON(t, server.URL+"/v1/workspace/exec-target-order", cookie.Value, csrf, string(body))

	assert.NotEqual(t, http.StatusOK, resp.StatusCode)
	assert.Empty(t, stub.orderInputs, "越界的排列不得走到 service")
}

// 会话索引的项目轴：项目树带父标识与颜色，浏览器据此把项目递归成组头。
func TestListProjects_CarriesTreeShapeWithoutPaths(t *testing.T) {
	stub := &stubWorkspaceSvc{projects: []workspace_svc.ProjectNodeView{
		{SyncID: "proj-parent", Name: "后端", Color: "#3B82F6"},
		{SyncID: "proj-child", Name: "agentre-server", Color: "#10B981",
			ParentSyncID: "proj-parent", SortOrder: 2},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/projects", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Projects []struct {
			SyncID       string `json:"sync_id"`
			Name         string `json:"name"`
			Color        string `json:"color"`
			ParentSyncID string `json:"parent_sync_id"`
			SortOrder    int    `json:"sort_order"`
		} `json:"projects"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Projects, 2)
	assert.Equal(t, "proj-parent", got.Projects[1].ParentSyncID)
	assert.Equal(t, 2, got.Projects[1].SortOrder)
	assert.Equal(t, "#10B981", got.Projects[1].Color)
}

// 项目图标要过线到浏览器，才能画「项目色底 + 项目自己的图标」而不是通用文件夹；
// 从没选过图标的项目其响应里干脆不带这个键（omitempty），不是服务端替它补一个。
func TestListProjects_CarriesIconAndOmitsItWhenAbsent(t *testing.T) {
	stub := &stubWorkspaceSvc{projects: []workspace_svc.ProjectNodeView{
		{SyncID: "proj-with-icon", Name: "后端", Icon: "🚀", Color: "#3B82F6"},
		{SyncID: "proj-no-icon", Name: "前端", Color: "#10B981"},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/projects", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Projects []struct {
				SyncID string `json:"sync_id"`
				Icon   string `json:"icon"`
			} `json:"projects"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(body, &envelope), "response body: %s", body)
	require.Equal(t, 0, envelope.Code)
	require.Len(t, envelope.Data.Projects, 2)

	byID := map[string]string{}
	for _, p := range envelope.Data.Projects {
		byID[p.SyncID] = p.Icon
	}
	assert.Equal(t, "🚀", byID["proj-with-icon"])
	assert.Empty(t, byID["proj-no-icon"])
	assert.NotContains(t, string(body), `"icon":""`, "空图标不该伪造成一个空字符串键，omitempty 该把键整个省掉")
}
