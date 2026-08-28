package workspace_ctr_test

import (
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
)

// 组织面写通道的 controller 层守卫（规格 2026-08-18「server 端的组织管理面」）。

// 写入范围只由鉴权上下文圈定：请求体里那两个身份字段是伪造的，端点必须一个都不认，
// 落到 service 的账号只能是会话里的那个。
func TestCreateAgent_TakesAccountFromAuthContextAndIgnoresBodyIdentity(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/agents", cookie.Value, csrf,
		`{"name":"前端 Agent","prompt_json":"{\"text\":\"你是\"}","user_id":9,"account_id":9}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		SyncID  string `json:"sync_id"`
		Version int64  `json:"version"`
	}
	decodeEnvelope(t, resp, &got)
	assert.Equal(t, "written-1", got.SyncID)
	assert.Equal(t, int64(42), got.Version)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"create"}, stub.orgOps)
	assert.Equal(t, int64(7), stub.orgInputs[0].UserID, "账号来自会话，不是请求体")
	assert.Equal(t, sync_entity.KindAgent, stub.orgInputs[0].Kind)
	assert.Empty(t, stub.orgInputs[0].SyncID, "新建的同步标识由 server 分配")
	// 请求体里的 user_id / account_id 连进都进不来：请求结构体里没有那两个字段。
	assert.Equal(t, map[string]any{"name": "前端 Agent", "prompt_json": `{"text":"你是"}`},
		stub.orgInputs[0].Fields)
}

// 请求没提到的键不能被翻成零值送下去——送下去就等于让服务端把它写空，
// 而「不提」在这条通道上的含义是「别动它」。
func TestUpdateDepartment_SendsOnlyTheKeysTheRequestMentioned(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/departments/update", cookie.Value, csrf,
		`{"sync_id":"dept-1","name":"平台工程"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"update"}, stub.orgOps)
	assert.Equal(t, "dept-1", stub.orgInputs[0].SyncID)
	assert.Equal(t, sync_entity.KindDepartment, stub.orgInputs[0].Kind)
	assert.Equal(t, map[string]any{"name": "平台工程"}, stub.orgInputs[0].Fields,
		"description / icon / parent_sync_id 一个都不该出现")
}

// 排序这件事规格只给了执行目标：「web 组织面能管的是：部门（建 / 改 / 删）、
// Agent（建 / 改 / 删，含名称、简介、头像、配色、归属、系统提示词、工具授权）、
// 执行目标（增删档、排序、每档的技能授权）」。部门与 Agent 的 sort_order 因此
// 连表达都不该表达得出来——留着一个没有界面、没人要过的写口，只会让某天
// 一次 curl 悄悄打乱另一端读到的次序。
func TestUpdateDepartmentAndAgent_CannotExpressSortOrder(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/departments/update", cookie.Value, csrf,
		`{"sync_id":"dept-1","name":"平台工程","sort_order":9}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	resp = postJSON(t, server.URL+"/v1/workspace/org/agents/update", cookie.Value, csrf,
		`{"sync_id":"agent-1","name":"Eva","sort_order":9}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 2)
	for _, in := range stub.orgInputs {
		assert.NotContains(t, in.Fields, "sort_order",
			"排序不在 web 组织面能管的清单里")
	}
}

// 显式传空串是一个**有意义**的值（取消归属），必须原样送下去——把它与「没提到」
// 混为一谈，用户就再也取消不掉一个部门归属。
func TestUpdateAgent_ExplicitEmptyStringIsSentThrough(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/agents/update", cookie.Value, csrf,
		`{"sync_id":"agent-1","department_sync_id":""}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, map[string]any{"department_sync_id": ""}, stub.orgInputs[0].Fields)
}

// 删只带标识：不带任何键，服务端因此不会顺手改动正文。
func TestDeleteExecTarget_PassesKindAndSyncIDOnly(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/exec-targets/delete", cookie.Value, csrf,
		`{"sync_id":"t-1"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.orgInputs, 1)
	assert.Equal(t, []string{"delete"}, stub.orgOps)
	assert.Equal(t, sync_entity.KindAgentExecTarget, stub.orgInputs[0].Kind)
	assert.Equal(t, "t-1", stub.orgInputs[0].SyncID)
	assert.Empty(t, stub.orgInputs[0].Fields)
}

// service 的拒绝必须原样回到浏览器：这九个端点的成功回执只有标识与版本号，
// 吞掉错误返回一个空回执与成功在正文上不可分辨。
func TestOrgWrite_PropagatesServiceFailureInsteadOfEmptySuccess(t *testing.T) {
	stub := &stubWorkspaceSvc{orgErr: errors.New("create org object failed")}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	resp := postJSON(t, server.URL+"/v1/workspace/org/departments", cookie.Value, csrf,
		`{"name":"工程"}`)
	assert.Equal(t, http.StatusInternalServerError, resp.StatusCode)
	require.Len(t, stub.orgInputs, 1, "失败的这一次仍然应当走到 service")
}

// 未登录不得建改删任何人的组织架构；凭 cookie 鉴权的写还必须出示 CSRF 令牌。
func TestOrgWrite_RejectsUnauthenticatedAndCSRFLess(t *testing.T) {
	paths := []string{
		"/v1/workspace/org/departments",
		"/v1/workspace/org/departments/update",
		"/v1/workspace/org/departments/delete",
		"/v1/workspace/org/agents",
		"/v1/workspace/org/agents/update",
		"/v1/workspace/org/agents/delete",
		"/v1/workspace/org/exec-targets",
		"/v1/workspace/org/exec-targets/update",
		"/v1/workspace/org/exec-targets/delete",
	}
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, _ := newSessionCookieWithCSRF(t, 7)

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			anonymous := postJSON(t, server.URL+path, "", "", `{"sync_id":"x-1","name":"x"}`)
			assert.Equal(t, http.StatusUnauthorized, anonymous.StatusCode)

			noCSRF := postJSON(t, server.URL+path, cookie.Value, "", `{"sync_id":"x-1","name":"x"}`)
			assert.Equal(t, http.StatusForbidden, noCSRF.StatusCode)
		})
	}
	assert.Empty(t, stub.orgInputs, "一次都不该走到 service")
}

// 后端在 web 上只读：这条通道里**没有**建后端或改后端的端点，路由上根本不存在。
// 与 service 那一侧的 kind 白名单是两道独立的守卫——只有 service 那道时，
// 新加一条路由就能悄悄把它绕过去。
func TestOrgWrite_HasNoBackendEndpoint(t *testing.T) {
	stub := &stubWorkspaceSvc{}
	server, _ := newWorkspaceTestServer(t, stub)
	cookie, csrf := newSessionCookieWithCSRF(t, 7)

	for _, path := range []string{
		"/v1/workspace/org/backends",
		"/v1/workspace/org/backends/update",
		"/v1/workspace/org/backends/delete",
		"/v1/workspace/org/agent-backends",
	} {
		t.Run(path, func(t *testing.T) {
			resp := postJSON(t, server.URL+path, cookie.Value, csrf, `{"name":"claude","cli_path":"/x"}`)
			assert.Equal(t, http.StatusNotFound, resp.StatusCode)
		})
	}
	assert.Empty(t, stub.orgInputs)
}
