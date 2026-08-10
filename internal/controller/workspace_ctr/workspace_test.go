package workspace_ctr_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
	agents       []workspace_svc.AgentView
	detail       *workspace_svc.DeviceDetailView
	detailInputs []int64
	detailErr    error
	listCalled   bool
}

func (s *stubWorkspaceSvc) ListAccountAgents(context.Context, int64) ([]workspace_svc.AgentView, error) {
	s.listCalled = true
	return s.agents, nil
}

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
	sid, _, err := auth_svc.Default().StartSession(context.Background(), userID)
	require.NoError(t, err)
	return &http.Cookie{Name: testCookieName, Value: sid}
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
