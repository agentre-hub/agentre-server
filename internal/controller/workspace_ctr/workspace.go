// Package workspace_ctr 是 web 控制台两屏只读端点的控制器层：取调用方账号、转成
// service 入参、把视图对象转回响应结构，不做任何判定。
package workspace_ctr

import (
	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/workspace"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

type Workspace struct{}

func New() *Workspace { return &Workspace{} }

func (w *Workspace) ListAgents(c *gin.Context, req *api.ListAgentsRequest) (*api.ListAgentsResponse, error) {
	agents, err := workspace_svc.Default().ListAccountAgents(
		c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	resp := &api.ListAgentsResponse{Agents: make([]api.AgentItem, 0, len(agents))}
	for _, a := range agents {
		item := api.AgentItem{
			SyncID: a.SyncID, Name: a.Name, AvatarColor: a.AvatarColor,
			AvatarIcon: a.AvatarIcon, ProjectSyncIDs: a.ProjectSyncIDs,
			DepartmentName: a.DepartmentName, HasAvailableTarget: a.HasAvailableTarget,
			ExecTargets: make([]api.ExecTargetItem, 0, len(a.ExecTargets)),
		}
		for _, t := range a.ExecTargets {
			item.ExecTargets = append(item.ExecTargets, api.ExecTargetItem{
				Rank: t.Rank, BackendSyncID: t.BackendSyncID, IsLocalReference: t.IsLocalReference,
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
		c.Request.Context(), workspace_svc.WebDispatchPlanInput{
			UserID: ginctx.UserID(c), AgentSyncID: req.AgentSyncID,
			ProjectSyncID: req.ProjectSyncID, TargetBackendSyncID: req.TargetBackendSyncID,
		})
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
			Rank: t.Rank, BackendSyncID: t.BackendSyncID,
			DeviceID: t.DeviceID, DeviceName: t.DeviceName,
			BackendType: t.BackendType, Kind: t.Kind,
			Availability: t.Availability, Current: t.Current,
		})
	}
	if plan.Chosen != nil {
		resp.Chosen = &api.DispatchChoiceItem{
			DeviceFingerprint: plan.Chosen.DeviceFingerprint,
			DeviceID:          plan.Chosen.DeviceID,
			DeviceName:        plan.Chosen.DeviceName,
			BackendType:       plan.Chosen.BackendType,
			Kind:              plan.Chosen.Kind,
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
	detail, err := workspace_svc.Default().DeviceDetail(c.Request.Context(), ginctx.UserID(c), req.DeviceID)
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

// SetExecTargetOrder 把某个 Agent 的执行目标排成调用方要的次序（改的是账号默认
// 顺序）。账号取自鉴权上下文；这里只做入参转换，service 报错原样透传——响应体是空
// 的，吞掉错误就等于谎报成功。
func (w *Workspace) SetExecTargetOrder(
	c *gin.Context, req *api.SetExecTargetOrderRequest,
) (*api.SetExecTargetOrderResponse, error) {
	if err := workspace_svc.Default().SetExecTargetOrder(c.Request.Context(),
		workspace_svc.SetExecTargetOrderInput{
			UserID:         ginctx.UserID(c),
			AgentSyncID:    req.AgentSyncID,
			BackendSyncIDs: req.BackendSyncIDs,
		}); err != nil {
		return nil, err
	}
	return &api.SetExecTargetOrderResponse{}, nil
}

// ListProjectMachines 回「这个项目在每台机器上落在哪」（项目设置的「机器与路径」）。
// **agentred 逐条带路径正文**——R19 本轮唯一收窄的一处，见 api 那一侧的注释；
// 桌面端只回布尔。
func (w *Workspace) ListProjectMachines(
	c *gin.Context, req *api.ProjectMachinesRequest,
) (*api.ProjectMachinesResponse, error) {
	machines, err := workspace_svc.Default().ProjectMachines(
		c.Request.Context(), ginctx.UserID(c), req.ProjectSyncID)
	if err != nil {
		return nil, err
	}
	resp := &api.ProjectMachinesResponse{Machines: make([]api.ProjectMachineItem, 0, len(machines))}
	for _, m := range machines {
		resp.Machines = append(resp.Machines, api.ProjectMachineItem{
			DeviceID: m.DeviceID, DeviceName: m.DeviceName, Kind: m.Kind,
			Fingerprint: m.Fingerprint, Online: m.Online, Configured: m.Configured,
			Path: m.Path, LocationSyncID: m.LocationSyncID,
		})
	}
	return resp, nil
}

// ListProjects 回账号的项目树（会话索引的项目轴组头）。
func (w *Workspace) ListProjects(c *gin.Context, req *api.AccountProjectsRequest) (*api.AccountProjectsResponse, error) {
	projects, err := workspace_svc.Default().AccountProjects(c.Request.Context(), ginctx.UserID(c))
	if err != nil {
		return nil, err
	}
	resp := &api.AccountProjectsResponse{Projects: make([]api.ProjectNodeItem, 0, len(projects))}
	for _, p := range projects {
		item := api.ProjectNodeItem{
			SyncID: p.SyncID, Name: p.Name, Icon: p.Icon, Color: p.Color,
			Description: p.Description, ParentSyncID: p.ParentSyncID, SortOrder: p.SortOrder,
			Configured: p.Configured,
		}
		for _, m := range p.Members {
			item.Members = append(item.Members,
				api.ProjectMemberItem{SyncID: m.SyncID, AgentSyncID: m.AgentSyncID})
		}
		resp.Projects = append(resp.Projects, item)
	}
	return resp, nil
}
