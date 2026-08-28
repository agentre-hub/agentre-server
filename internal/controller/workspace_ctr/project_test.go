package workspace_ctr_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// 项目一族写通道的 controller 层守卫（规格 2026-08-20「项目在 web 上成为一件可管理
// 的事」）。判据与组织面那三族逐字同形：账号只由鉴权圈定、没提到的键不翻成零值、
// 删只带标识。

// 写入范围只由鉴权上下文圈定：请求体里那两个身份字段是伪造的，端点一个都不认。
func TestCreateProject_TakesAccountFromAuthContextAndIgnoresBodyIdentity(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/projects", cookie.Value, csrf,
		`{"name":"agentre-server","description":"服务端","color":"agent-7","user_id":9,"account_id":9}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"create"}, stub.orgOps)
	assert.Equal(t, int64(7), stub.orgInputs[0].UserID, "账号来自会话，不是请求体")
	assert.Equal(t, sync_entity.KindProject, stub.orgInputs[0].Kind)
	assert.Empty(t, stub.orgInputs[0].SyncID, "新建的同步标识由 server 分配")
	// 请求体里的 user_id / account_id 连进都进不来：请求结构体里没有那两个字段。
	assert.Equal(t, map[string]any{
		"name": "agentre-server", "description": "服务端", "color": "agent-7",
	}, stub.orgInputs[0].Fields)
}

// 新建时不给父项目、不给路径都是正当的（决策 7）：路径根本不是项目的字段，
// 父项目不传即挂在根上。两者都不该被翻成一个空值送下去。
func TestCreateProject_GivenOnlyAName_ThenNothingElseIsSentDown(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/projects", cookie.Value, csrf,
		`{"name":"新项目"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, map[string]any{"name": "新项目"}, stub.orgInputs[0].Fields)
}

// 请求没提到的键不能被翻成零值送下去——送下去就等于让服务端把它写空，
// 而「不提」在这条通道上的含义是「别动它」。项目设置是即时保存（决策 8），
// 每次 blur 只提交改动的那一个字段，这条判据因此比别处更吃紧。
func TestUpdateProject_SendsOnlyTheKeysTheRequestMentioned(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/projects/update", cookie.Value, csrf,
		`{"sync_id":"proj-1","name":"agentre-server"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"update"}, stub.orgOps)
	assert.Equal(t, "proj-1", stub.orgInputs[0].SyncID)
	assert.Equal(t, sync_entity.KindProject, stub.orgInputs[0].Kind)
	assert.Equal(t, map[string]any{"name": "agentre-server"}, stub.orgInputs[0].Fields,
		"description / icon / color / parent_sync_id / sort_order 一个都不该出现")
}

// 显式传空串是「挂回根上」这个有意的值，与「没提到」不是同一件事，必须原样送下去。
func TestUpdateProject_ExplicitEmptyParentIsSentThrough(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/projects/update", cookie.Value, csrf,
		`{"sync_id":"proj-1","parent_sync_id":""}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, map[string]any{"parent_sync_id": ""}, stub.orgInputs[0].Fields)
}

func TestDeleteProject_PassesKindAndSyncIDOnly(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/projects/delete", cookie.Value, csrf,
		`{"sync_id":"proj-1"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"delete"}, stub.orgOps)
	assert.Equal(t, sync_entity.KindProject, stub.orgInputs[0].Kind)
	assert.Equal(t, "proj-1", stub.orgInputs[0].SyncID)
	assert.Empty(t, stub.orgInputs[0].Fields)
}

// 加成员：两端都送下去，账号仍然只来自会话。
func TestCreateProjectMember_SendsBothEndsAndTakesAccountFromAuthContext(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/project-members", cookie.Value, csrf,
		`{"project_sync_id":"proj-1","agent_sync_id":"agent-1","user_id":9}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"create"}, stub.orgOps)
	assert.Equal(t, int64(7), stub.orgInputs[0].UserID)
	assert.Equal(t, sync_entity.KindProjectAgent, stub.orgInputs[0].Kind)
	assert.Equal(t, map[string]any{
		"project_sync_id": "proj-1", "agent_sync_id": "agent-1",
	}, stub.orgInputs[0].Fields)
}

// 成员关系两端都必填：少一端的请求在绑定这一层就被拒，一步都走不到 service。
func TestCreateProjectMember_GivenAMissingEnd_ThenRejectedBeforeService(t *testing.T) {
	for name, body := range map[string]string{
		"没有项目":     `{"agent_sync_id":"agent-1"}`,
		"没有 Agent": `{"project_sync_id":"proj-1"}`,
	} {
		t.Run(name, func(t *testing.T) {
			stub := &stubWorkspaceSvc{}
			server, _ := newWorkspaceTestServer(t, stub)
			cookie, csrf := newSessionCookieWithCSRF(t, 7)

			resp := postJSON(t, server.URL+"/v1/workspace/org/project-members", cookie.Value, csrf, body)
			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
			assert.Empty(t, stub.orgInputs, "一步都不该走到 service")
		})
	}
}

// 删成员按**这条成员关系自己的**同步标识，不是按 Agent 的：同一个 Agent 可以是好几个
// 项目的成员，按 Agent 删说不清删的是哪一个项目里的。
func TestDeleteProjectMember_PassesTheMembershipSyncIDOnly(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/project-members/delete", cookie.Value, csrf,
		`{"sync_id":"pa-1"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"delete"}, stub.orgOps)
	assert.Equal(t, sync_entity.KindProjectAgent, stub.orgInputs[0].Kind)
	assert.Equal(t, "pa-1", stub.orgInputs[0].SyncID)
	assert.Empty(t, stub.orgInputs[0].Fields)
}

// 未登录不得建改删任何人的项目；凭 cookie 鉴权的写还必须出示 CSRF 令牌。
func TestProjectWrite_RejectsUnauthenticatedAndCSRFLess(t *testing.T) {
	paths := []string{
		"/v1/workspace/org/projects",
		"/v1/workspace/org/projects/update",
		"/v1/workspace/org/projects/delete",
		"/v1/workspace/org/project-members",
		"/v1/workspace/org/project-members/delete",
	}
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, _ := newSessionCookieWithCSRF(t, 7)

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			body := `{"sync_id":"x-1","name":"x","project_sync_id":"p-1","agent_sync_id":"a-1"}`
			anonymous := postJSON(t, server.URL+path, "", "", body)
			assert.Equal(t, http.StatusUnauthorized, anonymous.StatusCode)

			noCSRF := postJSON(t, server.URL+path, cookie.Value, "", body)
			assert.Equal(t, http.StatusForbidden, noCSRF.StatusCode)
		})
	}
	assert.Empty(t, stub.orgInputs, "一次都不该走到 service")
}

// 项目树的读侧：简介与成员都要到得了浏览器，成员一项带的是**这条成员关系自己的**
// 同步标识（删成员按它定位）。路径仍然一个字段都没有（R19）。
func TestListProjects_CarriesDescriptionAndMembers(t *testing.T) {
	stub := &stubWorkspaceSvc{projects: []workspace_svc.ProjectNodeView{
		{
			SyncID: "proj-1", Name: "后端", Description: "服务端那一半",
			Members: []workspace_svc.ProjectMemberView{
				{SyncID: "pa-1", AgentSyncID: "agent-a"},
				{SyncID: "pa-2", AgentSyncID: "agent-b"},
			},
		},
		{SyncID: "proj-2", Name: "前端"},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, _ := newSessionCookieWithCSRF(t, 7)

	resp := get(t, server.URL+"/v1/workspace/projects", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Projects []struct {
			SyncID      string `json:"sync_id"`
			Description string `json:"description"`
			Members     []struct {
				SyncID      string `json:"sync_id"`
				AgentSyncID string `json:"agent_sync_id"`
			} `json:"members"`
		} `json:"projects"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Projects, 2)
	assert.Equal(t, "服务端那一半", got.Projects[0].Description)
	require.Len(t, got.Projects[0].Members, 2)
	assert.Equal(t, "pa-1", got.Projects[0].Members[0].SyncID)
	assert.Equal(t, "agent-a", got.Projects[0].Members[0].AgentSyncID)
	assert.Equal(t, "pa-2", got.Projects[0].Members[1].SyncID)
	assert.Empty(t, got.Projects[1].Description)
	assert.Empty(t, got.Projects[1].Members, "没有成员的项目如实给空，不借别人的")
}

// ── 机器与路径（规格 2026-08-20「路径与 R19」）────────────────────────────────

// 读那一节：两类机器都带路径正文（规格 2026-08-21 决策 5），但只有 agentred 带
// `location_sync_id`——桌面端在同步组里没有那样一行，「移除」经中继喊它自己去做。
func TestListProjectMachines_CarriesPathsForBothKindsButOnlyAgentredCanBeDeletedHere(t *testing.T) {
	stub := &stubWorkspaceSvc{machines: []workspace_svc.ProjectMachineView{
		{
			DeviceID: 1, DeviceName: "build-01", Kind: "agentred", Fingerprint: "fp-1",
			Online: true, Configured: true, Path: "/srv/agentre-server", LocationSyncID: "pl-1",
		},
		{
			DeviceID: 2, DeviceName: "wangyz-mbp", Kind: "desktop", Fingerprint: "fp-d",
			Online: true, Configured: true, Path: "/Users/me/code/agentre",
		},
	}}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, _ := newSessionCookieWithCSRF(t, 7)

	resp := get(t, server.URL+"/v1/workspace/projects/machines?project_sync_id=proj-1", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Machines []struct {
			DeviceID       int64  `json:"device_id"`
			DeviceName     string `json:"device_name"`
			Kind           string `json:"kind"`
			Fingerprint    string `json:"fingerprint"`
			Online         bool   `json:"online"`
			Configured     bool   `json:"configured"`
			Path           string `json:"path"`
			LocationSyncID string `json:"location_sync_id"`
		} `json:"machines"`
	}
	decodeEnvelope(t, resp, &got)
	require.Len(t, got.Machines, 2)

	assert.Equal(t, "/srv/agentre-server", got.Machines[0].Path)
	assert.Equal(t, "pl-1", got.Machines[0].LocationSyncID)
	assert.Equal(t, "fp-1", got.Machines[0].Fingerprint, "目录选择器要靠它拨中继")
	assert.True(t, got.Machines[0].Online)

	assert.Equal(t, "desktop", got.Machines[1].Kind)
	assert.True(t, got.Machines[1].Configured)
	assert.Equal(t, "/Users/me/code/agentre", got.Machines[1].Path,
		"改不了一个看不见的值：这一行现在改得动，正文就得给")
	assert.Equal(t, "fp-d", got.Machines[1].Fingerprint, "目录选择器与写入都靠它拨中继")
	assert.Empty(t, got.Machines[1].LocationSyncID,
		"桌面端在同步组里没有那样一行：移除经中继喊那台机器自己去做")

	// 账号来自会话，项目来自查询串。
	assert.Equal(t, []string{"7:proj-1"}, stub.machineInputs)
}

// 不带项目就问不出东西：这一节永远是「某个项目」的材料。
func TestListProjectMachines_GivenNoProject_ThenRejectedBeforeService(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, _ := newSessionCookieWithCSRF(t, 7)

	resp := get(t, server.URL+"/v1/workspace/projects/machines", cookie.Value)
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Empty(t, stub.machineInputs, "一步都不该走到 service")
}

// 写路径：请求带的是**目标机器的指纹**而不是 device_id，账号仍然只来自会话。
func TestSetProjectLocation_PassesFingerprintAndPathAndTakesAccountFromAuthContext(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/project-locations", cookie.Value, csrf,
		`{"project_sync_id":"proj-1","device_fingerprint":"fp-1","path":"/srv/agentre-server","user_id":9}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.locationInputs, 1)
	assert.Equal(t, workspace_svc.SetProjectLocationInput{
		UserID: 7, ProjectSyncID: "proj-1", Fingerprint: "fp-1", Path: "/srv/agentre-server",
	}, stub.locationInputs[0])
	assert.Empty(t, stub.orgInputs, "它不走通用写通道：先按自然键判改还是建")
}

// 三件缺一不可，缺件在绑定这一层就被拒。
func TestSetProjectLocation_GivenAMissingPiece_ThenRejectedBeforeService(t *testing.T) {
	for name, body := range map[string]string{
		"没有项目": `{"device_fingerprint":"fp-1","path":"/srv/x"}`,
		"没有指纹": `{"project_sync_id":"proj-1","path":"/srv/x"}`,
		"没有路径": `{"project_sync_id":"proj-1","device_fingerprint":"fp-1"}`,
	} {
		t.Run(name, func(t *testing.T) {
			stub := &stubWorkspaceSvc{}
			server, _ := newWorkspaceTestServer(t, stub)
			cookie, csrf := newSessionCookieWithCSRF(t, 7)

			resp := postJSON(t, server.URL+"/v1/workspace/org/project-locations", cookie.Value, csrf, body)
			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
			assert.Empty(t, stub.locationInputs, "一步都不该走到 service")
		})
	}
}

// 移除一条路径走的是通用删除通道，只带这一行的同步标识。
func TestDeleteProjectLocation_PassesKindAndSyncIDOnly(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/project-locations/delete", cookie.Value, csrf,
		`{"sync_id":"pl-1"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"delete"}, stub.orgOps)
	assert.Equal(t, sync_entity.KindProjectLocation, stub.orgInputs[0].Kind)
	assert.Equal(t, "pl-1", stub.orgInputs[0].SyncID)
	assert.Empty(t, stub.orgInputs[0].Fields)
}

// 未登录不得配任何人的路径；凭 cookie 鉴权的写还必须出示 CSRF 令牌。
func TestProjectLocationWrite_RejectsUnauthenticatedAndCSRFLess(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, _ := newSessionCookieWithCSRF(t, 7)

	for _, path := range []string{
		"/v1/workspace/org/project-locations",
		"/v1/workspace/org/project-locations/delete",
	} {
		t.Run(path, func(t *testing.T) {
			body := `{"sync_id":"pl-1","project_sync_id":"proj-1","device_fingerprint":"fp-1","path":"/srv/x"}`
			anonymous := postJSON(t, server.URL+path, "", "", body)
			assert.Equal(t, http.StatusUnauthorized, anonymous.StatusCode)

			noCSRF := postJSON(t, server.URL+path, cookie.Value, "", body)
			assert.Equal(t, http.StatusForbidden, noCSRF.StatusCode)
		})
	}
	assert.Empty(t, stub.locationInputs, "一次都不该走到 service")
	assert.Empty(t, stub.orgInputs, "一次都不该走到 service")
}
