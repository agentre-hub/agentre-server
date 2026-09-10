package workspace_ctr

import (
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/workspace"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// 看板的八个端点（规格 2026-08-27-issues-board-project-scope「`agentre-server` 端」）。
//
// 与组织面同理：这一层只把「这次请求提到了哪些键」翻成 service 要的 map，账号从鉴权
// 上下文里取。**账号不来自请求体**——请求结构体里根本没有那个字段，跨账号因此在契约上
// 就读不到也写不进去。六个筛选条件的语义、计数口径、版本号与墓碑一概在 workspace_svc。

// Board 一次取回看板要画的全部材料。
func (w *Workspace) Board(c *gin.Context, req *api.IssueBoardRequest) (*api.IssueBoardResponse, error) {
	view, err := workspace_svc.IssueBoard().Board(c.Request.Context(), workspace_svc.IssueBoardQuery{
		UserID: ginctx.UserID(c), Scope: req.Scope, ProjectSyncID: req.ProjectSyncID,
		Keyword: req.Keyword, LabelSyncIDs: req.LabelSyncIDs,
		LabelMatchAll: req.LabelMatchAll, NoLabel: req.NoLabel,
		UpdatedFrom: req.UpdatedFrom, UpdatedTo: req.UpdatedTo,
		CreatedFrom: req.CreatedFrom, CreatedTo: req.CreatedTo,
		DoneWithinDays: req.DoneWithinDays,
	})
	if err != nil {
		return nil, err
	}
	resp := &api.IssueBoardResponse{
		Issues:        make([]api.IssueItem, 0, len(view.Issues)),
		Labels:        toLabelItems(view.Labels),
		StageCounts:   view.StageCounts,
		StageTotals:   view.StageTotals,
		ProjectCounts: make([]api.ProjectIssueCountItem, 0, len(view.ProjectCounts)),
	}
	for _, it := range view.Issues {
		resp.Issues = append(resp.Issues, api.IssueItem{
			SyncID: it.SyncID, Title: it.Title, Description: it.Description,
			Stage: it.Stage, Position: it.Position, ProjectSyncID: it.ProjectSyncID,
			AgentSyncID: it.AgentSyncID, AgentBackendSyncID: it.AgentBackendSyncID,
			LLMProviderKey: it.LLMProviderKey, LLMModelKey: it.LLMModelKey,
			ClosedAt: it.ClosedAt, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt,
			Labels: toLabelItems(it.Labels),
		})
	}
	for _, c := range view.ProjectCounts {
		resp.ProjectCounts = append(resp.ProjectCounts,
			api.ProjectIssueCountItem{ProjectSyncID: c.ProjectSyncID, Count: c.Count})
	}
	return resp, nil
}

func toLabelItems(views []workspace_svc.IssueLabelView) []api.LabelItem {
	out := make([]api.LabelItem, 0, len(views))
	for _, l := range views {
		out = append(out, api.LabelItem{
			SyncID: l.SyncID, Name: l.Name, Tone: l.Tone, UsageCount: l.UsageCount})
	}
	return out
}

// issueFields 与 org.go 的 putString 同一口径：字段真的出现在请求里（指针非 nil）
// 才写进 map，没写进去的键 service 就不会覆盖。空串是一个**有意义**的值
// （「取消项目归属」「清掉执行归属」），所以判的是 nil 而不是零值。
func issueFields(f api.IssueFields) map[string]any {
	m := make(map[string]any, 8)
	putString(m, "title", f.Title)
	putString(m, "description", f.Description)
	putString(m, "stage", f.Stage)
	putString(m, "project_sync_id", f.ProjectSyncID)
	putString(m, "agent_sync_id", f.AgentSyncID)
	putString(m, "agent_backend_sync_id", f.AgentBackendSyncID)
	putString(m, "llm_provider_key", f.LLMProviderKey)
	putString(m, "llm_model_key", f.LLMModelKey)
	return m
}

func issueLabelFields(f api.IssueLabelFields) map[string]any {
	m := make(map[string]any, 2)
	putString(m, "name", f.Name)
	putString(m, "tone", f.Tone)
	return m
}

func issueWriteResponse(res *workspace_svc.OrgWriteResult, err error) (*api.OrgWriteResponse, error) {
	if err != nil {
		return nil, err
	}
	return &api.OrgWriteResponse{SyncID: res.SyncID, Version: res.Version}, nil
}

func (w *Workspace) CreateIssue(
	c *gin.Context, req *api.CreateIssueRequest,
) (*api.OrgWriteResponse, error) {
	return issueWriteResponse(workspace_svc.IssueBoard().CreateIssue(
		c.Request.Context(), workspace_svc.IssueWriteInput{
			UserID: ginctx.UserID(c), Fields: issueFields(req.IssueFields),
			LabelSyncIDs: req.LabelSyncIDs,
		}))
}

func (w *Workspace) UpdateIssue(
	c *gin.Context, req *api.UpdateIssueRequest,
) (*api.OrgWriteResponse, error) {
	return issueWriteResponse(workspace_svc.IssueBoard().UpdateIssue(
		c.Request.Context(), workspace_svc.IssueWriteInput{
			UserID: ginctx.UserID(c), SyncID: req.SyncID,
			Fields: issueFields(req.IssueFields), LabelSyncIDs: req.LabelSyncIDs,
		}))
}

func (w *Workspace) MoveIssue(
	c *gin.Context, req *api.MoveIssueRequest,
) (*api.OrgWriteResponse, error) {
	return issueWriteResponse(workspace_svc.IssueBoard().MoveIssue(
		c.Request.Context(), workspace_svc.IssueMoveInput{
			UserID: ginctx.UserID(c), SyncID: req.SyncID,
			Stage: req.Stage, AfterSyncID: req.AfterSyncID,
		}))
}

func (w *Workspace) DeleteIssue(
	c *gin.Context, req *api.DeleteIssueRequest,
) (*api.OrgWriteResponse, error) {
	return issueWriteResponse(workspace_svc.IssueBoard().DeleteIssue(
		c.Request.Context(), ginctx.UserID(c), req.SyncID))
}

func (w *Workspace) CreateIssueLabel(
	c *gin.Context, req *api.CreateIssueLabelRequest,
) (*api.OrgWriteResponse, error) {
	return issueWriteResponse(workspace_svc.IssueBoard().CreateLabel(
		c.Request.Context(), workspace_svc.LabelWriteInput{
			UserID: ginctx.UserID(c), Fields: issueLabelFields(req.IssueLabelFields),
		}))
}

func (w *Workspace) UpdateIssueLabel(
	c *gin.Context, req *api.UpdateIssueLabelRequest,
) (*api.OrgWriteResponse, error) {
	return issueWriteResponse(workspace_svc.IssueBoard().UpdateLabel(
		c.Request.Context(), workspace_svc.LabelWriteInput{
			UserID: ginctx.UserID(c), SyncID: req.SyncID,
			Fields: issueLabelFields(req.IssueLabelFields),
		}))
}

func (w *Workspace) DeleteIssueLabel(
	c *gin.Context, req *api.DeleteIssueLabelRequest,
) (*api.OrgWriteResponse, error) {
	return issueWriteResponse(workspace_svc.IssueBoard().DeleteLabel(
		c.Request.Context(), ginctx.UserID(c), req.SyncID))
}
