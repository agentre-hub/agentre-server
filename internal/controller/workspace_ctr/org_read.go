package workspace_ctr

import (
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/workspace"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// 组织面的两个读端点（规格 2026-08-18「server 端的组织管理面」）。与写通道同理：
// 账号取自鉴权上下文，请求里没有身份字段；判定一概在 workspace_svc。

// OrgChart 回索引与详情的全部材料：部门（含空部门与父子关系）与 Agent（含完整
// 组织字段与每档执行目标）。
func (w *Workspace) OrgChart(c *gin.Context, req *api.OrgChartRequest) (*api.OrgChartResponse, error) {
	chart, err := workspace_svc.Default().OrgChart(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	resp := &api.OrgChartResponse{
		Departments: make([]api.OrgDepartmentItem, 0, len(chart.Departments)),
		Agents:      make([]api.OrgAgentItem, 0, len(chart.Agents)),
	}
	for _, d := range chart.Departments {
		resp.Departments = append(resp.Departments, api.OrgDepartmentItem{
			SyncID: d.SyncID, Name: d.Name, Description: d.Description,
			Icon: d.Icon, AccentColor: d.AccentColor, ParentSyncID: d.ParentSyncID,
			LeadAgentSyncID: d.LeadAgentSyncID, SortOrder: d.SortOrder,
		})
	}
	for _, a := range chart.Agents {
		item := api.OrgAgentItem{
			SyncID: a.SyncID, Name: a.Name, Description: a.Description,
			AvatarColor: a.AvatarColor, AvatarIcon: a.AvatarIcon, SystemBadge: a.SystemBadge,
			DepartmentSyncID: a.DepartmentSyncID, ParentAgentSyncID: a.ParentAgentSyncID,
			SortOrder: a.SortOrder, PromptJSON: a.PromptJSON, ToolsJSON: a.ToolsJSON,
			ExecTargets: make([]api.OrgExecTargetItem, 0, len(a.ExecTargets)),
		}
		for _, t := range a.ExecTargets {
			item.ExecTargets = append(item.ExecTargets, api.OrgExecTargetItem{
				SyncID: t.SyncID, Rank: t.Rank, BackendSyncID: t.BackendSyncID,
				BackendName: t.BackendName, BackendType: t.BackendType,
				DeviceID: t.DeviceID, DeviceName: t.DeviceName,
				DeviceFingerprint: t.DeviceFingerprint,
				IsLocalReference:  t.IsLocalReference, Availability: t.Availability,
				Current: t.Current, SkillsJSON: t.SkillsJSON,
			})
		}
		resp.Agents = append(resp.Agents, item)
	}
	return resp, nil
}

// SelectableBackends 回配一档执行目标时能挑的后端清单（只读：浏览器建不出后端）。
func (w *Workspace) SelectableBackends(
	c *gin.Context, req *api.OrgBackendsRequest,
) (*api.OrgBackendsResponse, error) {
	backends, err := workspace_svc.Default().SelectableBackends(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	resp := &api.OrgBackendsResponse{Backends: make([]api.OrgBackendItem, 0, len(backends))}
	for _, b := range backends {
		resp.Backends = append(resp.Backends, api.OrgBackendItem{
			SyncID: b.SyncID, Name: b.Name, BackendType: b.BackendType,
			DeviceID: b.DeviceID, DeviceName: b.DeviceName,
			IsLocalReference: b.IsLocalReference, Availability: b.Availability,
		})
	}
	return resp, nil
}
