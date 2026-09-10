package workspace_ctr_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// 组织面读端点的 controller 层（规格 2026-08-18「server 端的组织管理面」）：
// 浏览器仅凭会话就要读到索引与详情的全部材料。

// 索引与详情一次取回：空部门照常在场、父子关系读得到、Agent 带着详情要编辑的
// 那一份完整字段、执行目标一档一行且技能折在行内。
func TestOrgChart_ServesDepartmentsAndAgentsForBrowserSession(t *testing.T) {
	stub := &stubWorkspaceSvc{orgChart: &workspace_svc.OrgChartView{
		Departments: []workspace_svc.OrgDepartmentView{
			{SyncID: "dept-empty", Name: "还没人的部门", SortOrder: 0},
			{SyncID: "dept-eng", Name: "工程", AccentColor: "#3B6896",
				LeadAgentSyncID: "agent-1", SortOrder: 1},
			{SyncID: "dept-fe", Name: "前端", ParentSyncID: "dept-eng", SortOrder: 2},
		},
		Agents: []workspace_svc.OrgAgentView{{
			SyncID: "agent-1", Name: "前端 Agent", Description: "管样式的",
			AvatarColor: "#3B6896", AvatarIcon: "sparkles", SystemBadge: "default",
			DepartmentSyncID: "dept-eng", SortOrder: 3,
			PromptJSON: `{"text":"你是一个前端"}`, ToolsJSON: `{"granted":["org"]}`,
			ExecTargets: []workspace_svc.OrgExecTargetView{{
				SyncID: "target-1", Rank: 1, BackendSyncID: "backend-1",
				BackendName: "公司的 Codex", BackendType: "codex",
				DeviceID: 21, DeviceName: "公司 Mac mini", DeviceFingerprint: "fp-online",
				Availability: workspace_svc.AvailabilityAvailable, Current: true,
				SkillsJSON: `{"granted":["web-search"]}`,
			}},
		}},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/org", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, []int64{7}, stub.orgChartInputs, "账号来自会话")

	var got struct {
		Departments []struct {
			SyncID          string `json:"sync_id"`
			Name            string `json:"name"`
			ParentSyncID    string `json:"parent_sync_id"`
			LeadAgentSyncID string `json:"lead_agent_sync_id"`
			AccentColor     string `json:"accent_color"`
			SortOrder       int    `json:"sort_order"`
		} `json:"departments"`
		Agents []struct {
			SyncID            string `json:"sync_id"`
			Name              string `json:"name"`
			Description       string `json:"description"`
			AvatarColor       string `json:"avatar_color"`
			AvatarIcon        string `json:"avatar_icon"`
			SystemBadge       string `json:"system_badge"`
			DepartmentSyncID  string `json:"department_sync_id"`
			ParentAgentSyncID string `json:"parent_agent_sync_id"`
			SortOrder         int    `json:"sort_order"`
			PromptJSON        string `json:"prompt_json"`
			ToolsJSON         string `json:"tools_json"`
			ExecTargets       []struct {
				SyncID        string `json:"sync_id"`
				Rank          int    `json:"rank"`
				BackendSyncID string `json:"backend_sync_id"`
				BackendName   string `json:"backend_name"`
				BackendType   string `json:"backend_type"`
				DeviceName    string `json:"device_name"`
				// 中继是点对点的：浏览器要在 URL 上带 daemon_fingerprint 才能拨到
				// 这一档所在的机器，问它「这个后端上装了哪些技能包」。
				DeviceFingerprint string `json:"device_fingerprint"`
				Availability      string `json:"availability"`
				Current           bool   `json:"current"`
				SkillsJSON        string `json:"skills_json"`
			} `json:"exec_targets"`
		} `json:"agents"`
	}
	decodeEnvelope(t, resp, &got)

	require.Len(t, got.Departments, 3, "空部门照常摆组头")
	assert.Equal(t, "还没人的部门", got.Departments[0].Name)
	assert.Equal(t, "agent-1", got.Departments[1].LeadAgentSyncID)
	assert.Equal(t, "#3B6896", got.Departments[1].AccentColor)
	assert.Equal(t, "dept-eng", got.Departments[2].ParentSyncID)

	require.Len(t, got.Agents, 1)
	agent := got.Agents[0]
	assert.Equal(t, "前端 Agent", agent.Name)
	assert.Equal(t, "管样式的", agent.Description)
	assert.Equal(t, "#3B6896", agent.AvatarColor)
	assert.Equal(t, "sparkles", agent.AvatarIcon)
	assert.Equal(t, "default", agent.SystemBadge)
	assert.Equal(t, "dept-eng", agent.DepartmentSyncID)
	assert.Equal(t, 3, agent.SortOrder)
	assert.Equal(t, `{"text":"你是一个前端"}`, agent.PromptJSON)
	assert.Equal(t, `{"granted":["org"]}`, agent.ToolsJSON)

	require.Len(t, agent.ExecTargets, 1)
	assert.Equal(t, "target-1", agent.ExecTargets[0].SyncID)
	assert.Equal(t, "公司的 Codex", agent.ExecTargets[0].BackendName)
	assert.Equal(t, "codex", agent.ExecTargets[0].BackendType)
	assert.Equal(t, "公司 Mac mini", agent.ExecTargets[0].DeviceName)
	assert.Equal(t, "fp-online", agent.ExecTargets[0].DeviceFingerprint,
		"浏览器据它经中继拨到这一档所在的机器")
	assert.Equal(t, workspace_svc.AvailabilityAvailable, agent.ExecTargets[0].Availability)
	assert.True(t, agent.ExecTargets[0].Current)
	assert.Equal(t, `{"granted":["web-search"]}`, agent.ExecTargets[0].SkillsJSON)
}

// 配一档执行目标时能挑的后端：**只读**的一份清单，每项说清楚在哪台机器上、
// 此刻能不能用。它是这条通道上唯一一个以后端为对象的端点，且只有 GET。
func TestSelectableBackends_ServesTheBackendPickerAndIsReadOnly(t *testing.T) {
	stub := &stubWorkspaceSvc{backends: []workspace_svc.OrgBackendView{
		{SyncID: "backend-1", Name: "公司的 Codex", BackendType: "codex",
			DeviceID: 21, DeviceName: "公司 Mac mini",
			Availability: workspace_svc.AvailabilityAvailable},
		{SyncID: "backend-2", Name: "没写运行设备的那个", BackendType: "claude_code",
			IsLocalReference: true, Availability: workspace_svc.AvailabilityNoDevice},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie := newSessionCookie(t, 7)

	resp := get(t, server.URL+"/v1/workspace/org/backends", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, []int64{7}, stub.backendsInputs)

	var got struct {
		Backends []struct {
			SyncID           string `json:"sync_id"`
			Name             string `json:"name"`
			BackendType      string `json:"backend_type"`
			DeviceID         int64  `json:"device_id"`
			DeviceName       string `json:"device_name"`
			IsLocalReference bool   `json:"is_local_reference"`
			Availability     string `json:"availability"`
		} `json:"backends"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Backends, 2)
	assert.Equal(t, "公司的 Codex", got.Backends[0].Name)
	assert.Equal(t, "codex", got.Backends[0].BackendType)
	assert.Equal(t, int64(21), got.Backends[0].DeviceID)
	assert.Equal(t, "公司 Mac mini", got.Backends[0].DeviceName)
	assert.Equal(t, workspace_svc.AvailabilityAvailable, got.Backends[0].Availability)
	assert.True(t, got.Backends[1].IsLocalReference)
	assert.Equal(t, workspace_svc.AvailabilityNoDevice, got.Backends[1].Availability)
}

// 未登录读不到任何人的组织架构：读的范围与写的一样，只由鉴权上下文里的账号圈定。
func TestOrgReads_RejectUnauthenticated(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)

	for _, path := range []string{"/v1/workspace/org", "/v1/workspace/org/backends"} {
		t.Run(path, func(t *testing.T) {
			resp := get(t, server.URL+path, "")
			assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
		})
	}
	assert.Empty(t, stub.orgChartInputs)
	assert.Empty(t, stub.backendsInputs)
}
