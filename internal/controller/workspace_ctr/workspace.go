// Package workspace_ctr 是 web 控制台两屏只读端点的控制器层：取调用方账号、转成
// service 入参、把视图对象转回响应结构，不做任何判定。
package workspace_ctr

import (
	"github.com/gin-gonic/gin"

	api "agentre-server/internal/api/workspace"
	"agentre-server/internal/service/workspace_svc"
)

type Workspace struct{}

func New() *Workspace { return &Workspace{} }

func callerUserID(c *gin.Context) int64 {
	uid, _ := c.Get("user_id")
	userID, _ := uid.(int64)
	return userID
}

func (w *Workspace) ListAgents(c *gin.Context, _ *api.ListAgentsRequest) (*api.ListAgentsResponse, error) {
	agents, err := workspace_svc.Default().ListAccountAgents(c.Request.Context(), callerUserID(c))
	if err != nil {
		return nil, err
	}
	resp := &api.ListAgentsResponse{Agents: make([]api.AgentItem, 0, len(agents))}
	for _, a := range agents {
		item := api.AgentItem{
			SyncID: a.SyncID, Name: a.Name, AvatarColor: a.AvatarColor,
			DepartmentName: a.DepartmentName, HasAvailableTarget: a.HasAvailableTarget,
			ExecTargets: make([]api.ExecTargetItem, 0, len(a.ExecTargets)),
		}
		for _, t := range a.ExecTargets {
			item.ExecTargets = append(item.ExecTargets, api.ExecTargetItem{
				Rank: t.Rank, IsLocalReference: t.IsLocalReference,
				DeviceID: t.DeviceID, DeviceName: t.DeviceName, BackendType: t.BackendType,
				Availability: t.Availability, Current: t.Current,
			})
		}
		resp.Agents = append(resp.Agents, item)
	}
	return resp, nil
}

func (w *Workspace) DispatchTarget(c *gin.Context, req *api.DispatchTargetRequest) (*api.DispatchTargetResponse, error) {
	plan, err := workspace_svc.Default().WebDispatchPlan(
		c.Request.Context(), callerUserID(c), req.AgentSyncID, req.ProjectSyncID)
	if err != nil {
		return nil, err
	}
	resp := &api.DispatchTargetResponse{
		AgentSyncID: plan.AgentSyncID,
		Tiers:       make([]api.DispatchTierItem, 0, len(plan.Tiers)),
		Projects:    make([]api.ProjectItem, 0, len(plan.Projects)),
	}
	for _, t := range plan.Tiers {
		resp.Tiers = append(resp.Tiers, api.DispatchTierItem{
			Rank: t.Rank, DeviceID: t.DeviceID, DeviceName: t.DeviceName,
			BackendType: t.BackendType, Availability: t.Availability, Current: t.Current,
		})
	}
	if plan.Chosen != nil {
		resp.Chosen = &api.DispatchChoiceItem{
			DeviceFingerprint: plan.Chosen.DeviceFingerprint,
			DeviceID:          plan.Chosen.DeviceID,
			DeviceName:        plan.Chosen.DeviceName,
			BackendType:       plan.Chosen.BackendType,
			Cwd:               plan.Chosen.Cwd,
		}
	}
	for _, p := range plan.Projects {
		resp.Projects = append(resp.Projects,
			api.ProjectItem{SyncID: p.SyncID, Name: p.Name, Configured: p.Configured})
	}
	return resp, nil
}

func (w *Workspace) DeviceDetail(c *gin.Context, req *api.DeviceDetailRequest) (*api.DeviceDetailResponse, error) {
	detail, err := workspace_svc.Default().DeviceDetail(c.Request.Context(), callerUserID(c), req.DeviceID)
	if err != nil {
		return nil, err
	}
	resp := &api.DeviceDetailResponse{
		DeviceID: detail.DeviceID, Kind: detail.Kind,
		Projects: make([]api.ProjectItem, 0, len(detail.Projects)),
	}
	for _, ra := range detail.RunnableAgents {
		resp.RunnableAgents = append(resp.RunnableAgents,
			api.RunnableAgentItem{SyncID: ra.SyncID, Name: ra.Name, Rank: ra.Rank})
	}
	for _, p := range detail.Projects {
		resp.Projects = append(resp.Projects, api.ProjectItem{SyncID: p.SyncID, Name: p.Name, Configured: p.Configured})
	}
	return resp, nil
}
