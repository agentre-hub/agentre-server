package workspace_ctr_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// 看板写通道的 controller 层守卫（规格 2026-08-27-issues-board-project-scope）。
//
// 这一层只做两件事：把「这次请求提到了哪些键」翻成 service 要的 map，以及从鉴权
// 上下文里取账号。判定一概不在这里，因此这些测试钉的也只有这两件事。

// stubIssueBoardSvc 记下实际收到的入参，实现 workspace_svc.IssueBoardSvc。
type stubIssueBoardSvc struct {
	board       *workspace_svc.IssueBoardView
	queries     []workspace_svc.IssueBoardQuery
	ops         []string
	issueInputs []workspace_svc.IssueWriteInput
	moveInputs  []workspace_svc.IssueMoveInput
	labelInputs []workspace_svc.LabelWriteInput
	deletes     []string
	deleteUsers []int64
}

func (s *stubIssueBoardSvc) Board(
	_ context.Context, q workspace_svc.IssueBoardQuery,
) (*workspace_svc.IssueBoardView, error) {
	s.queries = append(s.queries, q)
	if s.board == nil {
		return &workspace_svc.IssueBoardView{}, nil
	}
	return s.board, nil
}

func (s *stubIssueBoardSvc) write(op string) (*workspace_svc.OrgWriteResult, error) {
	s.ops = append(s.ops, op)
	return &workspace_svc.OrgWriteResult{SyncID: "written-1", Version: 42}, nil
}

func (s *stubIssueBoardSvc) CreateIssue(
	_ context.Context, in workspace_svc.IssueWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	s.issueInputs = append(s.issueInputs, in)
	return s.write("create-issue")
}

func (s *stubIssueBoardSvc) UpdateIssue(
	_ context.Context, in workspace_svc.IssueWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	s.issueInputs = append(s.issueInputs, in)
	return s.write("update-issue")
}

func (s *stubIssueBoardSvc) MoveIssue(
	_ context.Context, in workspace_svc.IssueMoveInput,
) (*workspace_svc.OrgWriteResult, error) {
	s.moveInputs = append(s.moveInputs, in)
	return s.write("move-issue")
}

func (s *stubIssueBoardSvc) DeleteIssue(
	_ context.Context, userID int64, syncID string,
) (*workspace_svc.OrgWriteResult, error) {
	s.deleteUsers, s.deletes = append(s.deleteUsers, userID), append(s.deletes, syncID)
	return s.write("delete-issue")
}

func (s *stubIssueBoardSvc) CreateLabel(
	_ context.Context, in workspace_svc.LabelWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	s.labelInputs = append(s.labelInputs, in)
	return s.write("create-label")
}

func (s *stubIssueBoardSvc) UpdateLabel(
	_ context.Context, in workspace_svc.LabelWriteInput,
) (*workspace_svc.OrgWriteResult, error) {
	s.labelInputs = append(s.labelInputs, in)
	return s.write("update-label")
}

func (s *stubIssueBoardSvc) DeleteLabel(
	_ context.Context, userID int64, syncID string,
) (*workspace_svc.OrgWriteResult, error) {
	s.deleteUsers, s.deletes = append(s.deleteUsers, userID), append(s.deletes, syncID)
	return s.write("delete-label")
}

func newBoardTestServer(t *testing.T) (string, *stubIssueBoardSvc, *http.Cookie, string) {
	t.Helper()
	stub := &stubIssueBoardSvc{}
	server, _ := newWorkspaceTestServer(t, &stubWorkspaceSvc{})
	workspace_svc.SetIssueBoard(stub)
	t.Cleanup(func() { workspace_svc.SetIssueBoard(workspace_svc.New()) })
	cookie, csrf := newSessionCookieWithCSRF(t, 7)
	return server.URL, stub, cookie, csrf
}

// 写入范围只由鉴权上下文圈定：请求体里那两个身份字段是伪造的，端点一个都不认。
// 它们连进都进不来——请求结构体里根本没有那两个字段。
func TestCreateIssue_TakesAccountFromAuthContextAndIgnoresBodyIdentity(t *testing.T) {
	base, stub, cookie, csrf := newBoardTestServer(t)

	resp := postJSON(t, base+"/v1/workspace/issues", cookie.Value, csrf,
		`{"title":"修网关超时","stage":"todo","agent_backend_sync_id":"b-1",
		  "label_sync_ids":["l-bug"],"user_id":9,"account_id":9}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		SyncID  string `json:"sync_id"`
		Version int64  `json:"version"`
	}
	decodeEnvelope(t, resp, &got)
	assert.Equal(t, "written-1", got.SyncID)
	assert.Equal(t, int64(42), got.Version)

	require.Len(t, stub.issueInputs, 1)
	assert.Equal(t, []string{"create-issue"}, stub.ops)
	assert.Equal(t, int64(7), stub.issueInputs[0].UserID, "账号来自会话，不是请求体")
	assert.Empty(t, stub.issueInputs[0].SyncID, "新建的同步标识由 server 分配")
	assert.Equal(t, map[string]any{
		"title": "修网关超时", "stage": "todo", "agent_backend_sync_id": "b-1",
	}, stub.issueInputs[0].Fields)
	require.NotNil(t, stub.issueInputs[0].LabelSyncIDs)
	assert.Equal(t, []string{"l-bug"}, *stub.issueInputs[0].LabelSyncIDs)
}

// 「没提到标签」与「摘掉全部标签」是两件事：前者一行关联都不该动，后者要清空。
// 混为一谈的那一刻，用户每改一次标题都会把这张卡的标签洗掉。
func TestUpdateIssue_DistinguishesOmittedLabelsFromAnEmptySet(t *testing.T) {
	base, stub, cookie, csrf := newBoardTestServer(t)

	resp := postJSON(t, base+"/v1/workspace/issues/update", cookie.Value, csrf,
		`{"sync_id":"i-1","title":"新标题"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	resp = postJSON(t, base+"/v1/workspace/issues/update", cookie.Value, csrf,
		`{"sync_id":"i-1","label_sync_ids":[]}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.issueInputs, 2)
	assert.Nil(t, stub.issueInputs[0].LabelSyncIDs, "没提到标签 = 别动它")
	assert.Equal(t, map[string]any{"title": "新标题"}, stub.issueInputs[0].Fields,
		"description / stage / 三个执行字段一个都不该出现")
	require.NotNil(t, stub.issueInputs[1].LabelSyncIDs)
	assert.Empty(t, *stub.issueInputs[1].LabelSyncIDs, "空数组 = 摘掉全部标签")
	assert.Empty(t, stub.issueInputs[1].Fields)
}

// 显式传空串是一个**有意义**的值（把卡片移出项目、清掉执行归属），必须原样送下去。
func TestUpdateIssue_ExplicitEmptyStringIsSentThrough(t *testing.T) {
	base, stub, cookie, csrf := newBoardTestServer(t)

	resp := postJSON(t, base+"/v1/workspace/issues/update", cookie.Value, csrf,
		`{"sync_id":"i-1","project_sync_id":"","agent_sync_id":""}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.issueInputs, 1)
	assert.Equal(t, map[string]any{"project_sync_id": "", "agent_sync_id": ""},
		stub.issueInputs[0].Fields)
}

// 拖动只说「落到哪一列、排在谁后面」；位置由服务端算——交给浏览器算，两个标签页
// 同时拖就会算出两个互相覆盖的值。契约里因此根本没有 position 这个键。
func TestMoveIssue_CarriesStageAndAnchorOnly(t *testing.T) {
	base, stub, cookie, csrf := newBoardTestServer(t)

	resp := postJSON(t, base+"/v1/workspace/issues/move", cookie.Value, csrf,
		`{"sync_id":"i-1","stage":"doing","after_sync_id":"i-2","position":123}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.moveInputs, 1)
	assert.Equal(t, workspace_svc.IssueMoveInput{
		UserID: 7, SyncID: "i-1", Stage: "doing", AfterSyncID: "i-2"}, stub.moveInputs[0])
}

// 四列之外的阶段在契约上就表达不出来：oneof 在 binding 层挡住，落不到 service。
func TestMoveIssue_GivenUnknownStage_ThenRefusedAtTheContract(t *testing.T) {
	base, stub, cookie, csrf := newBoardTestServer(t)

	resp := postJSON(t, base+"/v1/workspace/issues/move", cookie.Value, csrf,
		`{"sync_id":"i-1","stage":"archived"}`)
	assert.NotEqual(t, http.StatusOK, resp.StatusCode)
	assert.Empty(t, stub.moveInputs)
}

// 删任务与删标签都只带同步标识，账号来自会话。
func TestDeleteIssueAndLabel_TakeTheAccountFromTheSession(t *testing.T) {
	base, stub, cookie, csrf := newBoardTestServer(t)

	resp := postJSON(t, base+"/v1/workspace/issues/delete", cookie.Value, csrf,
		`{"sync_id":"i-1"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	resp = postJSON(t, base+"/v1/workspace/issues/labels/delete", cookie.Value, csrf,
		`{"sync_id":"l-1"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	assert.Equal(t, []string{"delete-issue", "delete-label"}, stub.ops)
	assert.Equal(t, []string{"i-1", "l-1"}, stub.deletes)
	assert.Equal(t, []int64{7, 7}, stub.deleteUsers)
}

// 建 / 改标签只有名字与色调两个键：status 由服务端记，浏览器写不了那个中间态。
func TestIssueLabelWrites_CarryNameAndToneOnly(t *testing.T) {
	base, stub, cookie, csrf := newBoardTestServer(t)

	resp := postJSON(t, base+"/v1/workspace/issues/labels", cookie.Value, csrf,
		`{"name":"性能","tone":"violet","status":2}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	resp = postJSON(t, base+"/v1/workspace/issues/labels/update", cookie.Value, csrf,
		`{"sync_id":"l-1","tone":"steel"}`)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.labelInputs, 2)
	assert.Equal(t, map[string]any{"name": "性能", "tone": "violet"}, stub.labelInputs[0].Fields)
	assert.Empty(t, stub.labelInputs[0].SyncID)
	assert.Equal(t, "l-1", stub.labelInputs[1].SyncID)
	assert.Equal(t, map[string]any{"tone": "steel"}, stub.labelInputs[1].Fields)
}

// 六个筛选条件与项目范围整条走查询串；账号照旧只来自会话。
func TestBoard_PassesEverySixFilterThrough(t *testing.T) {
	base, stub, cookie, _ := newBoardTestServer(t)

	resp := get(t, base+"/v1/workspace/issues?scope=project&project_sync_id=p-1"+
		"&keyword=%23179&label_sync_ids=l-a&label_sync_ids=l-b&label_match_all=true"+
		"&updated_from=100&updated_to=200&created_from=300&created_to=400"+
		"&done_within_days=30", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	require.Len(t, stub.queries, 1)
	assert.Equal(t, workspace_svc.IssueBoardQuery{
		UserID: 7, Scope: "project", ProjectSyncID: "p-1", Keyword: "#179",
		LabelSyncIDs: []string{"l-a", "l-b"}, LabelMatchAll: true,
		UpdatedFrom: 100, UpdatedTo: 200, CreatedFrom: 300, CreatedTo: 400,
		DoneWithinDays: 30,
	}, stub.queries[0])
}

// 响应把卡、标签目录、两套列头计数与项目子树计数一次交齐——看板画一屏不该问两趟。
func TestBoard_RendersCardsLabelsAndBothCountRows(t *testing.T) {
	base, stub, cookie, _ := newBoardTestServer(t)
	stub.board = &workspace_svc.IssueBoardView{
		Issues: []workspace_svc.IssueCardView{{
			SyncID: "i-1", Title: "修网关超时", Stage: "todo", Position: 65536,
			ProjectSyncID: "p-1", AgentBackendSyncID: "b-1", ClosedAt: 0,
			Labels: []workspace_svc.IssueLabelView{{SyncID: "l-bug", Name: "bug", Tone: "red"}},
		}},
		Labels:        []workspace_svc.IssueLabelView{{SyncID: "l-bug", Name: "bug", Tone: "red", UsageCount: 3}},
		StageCounts:   map[string]int64{"todo": 1, "doing": 0},
		StageTotals:   map[string]int64{"todo": 9, "doing": 2},
		ProjectCounts: []workspace_svc.ProjectIssueCountView{{ProjectSyncID: "p-1", Count: 4}},
	}

	resp := get(t, base+"/v1/workspace/issues", cookie.Value)
	assert.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Issues []struct {
			SyncID             string `json:"sync_id"`
			Stage              string `json:"stage"`
			AgentBackendSyncID string `json:"agent_backend_sync_id"`
			Labels             []struct {
				SyncID string `json:"sync_id"`
				Tone   string `json:"tone"`
			} `json:"labels"`
		} `json:"issues"`
		Labels []struct {
			SyncID     string `json:"sync_id"`
			UsageCount int64  `json:"usage_count"`
		} `json:"labels"`
		StageCounts   map[string]int64 `json:"stage_counts"`
		StageTotals   map[string]int64 `json:"stage_totals"`
		ProjectCounts []struct {
			ProjectSyncID string `json:"project_sync_id"`
			Count         int64  `json:"count"`
		} `json:"project_counts"`
	}
	decodeEnvelope(t, resp, &got)

	require.Len(t, got.Issues, 1)
	assert.Equal(t, "i-1", got.Issues[0].SyncID)
	assert.Equal(t, "b-1", got.Issues[0].AgentBackendSyncID)
	require.Len(t, got.Issues[0].Labels, 1)
	assert.Equal(t, "red", got.Issues[0].Labels[0].Tone)
	require.Len(t, got.Labels, 1)
	assert.Equal(t, int64(3), got.Labels[0].UsageCount)
	assert.Equal(t, map[string]int64{"todo": 1, "doing": 0}, got.StageCounts)
	assert.Equal(t, map[string]int64{"todo": 9, "doing": 2}, got.StageTotals)
	require.Len(t, got.ProjectCounts, 1)
	assert.Equal(t, int64(4), got.ProjectCounts[0].Count)
}
