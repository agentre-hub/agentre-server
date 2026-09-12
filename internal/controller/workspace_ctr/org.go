package workspace_ctr

import (
	"context"

	"github.com/gin-gonic/gin"

	api "github.com/agentre-hub/agentre-server/internal/api/workspace"
	"github.com/agentre-hub/agentre-server/internal/model/entity/sync_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/workspace_svc"
)

// 组织面的九个写端点（规格 2026-08-18「server 端的组织管理面」）。
//
// 这一层只做两件事：把「这次请求提到了哪些键」翻成 service 要的 map，以及从鉴权
// 上下文里取账号。**账号不来自请求体**——请求结构体里根本没有那个字段，跨账号因此
// 在契约上就写不进去，而不是靠这里记得别读。
//
// 判定一概不在这里：能不能写这个类型、载荷里未涉及的键怎么保留、删除怎么落墓碑，
// 全在 workspace_svc。

type orgWriteFunc func(context.Context, workspace_svc.OrgWriteInput) (*workspace_svc.OrgWriteResult, error)

// orgWrite 把一次写入交给 service 并把回执转成响应。错误原样透传：这九个端点的
// 响应体只有标识与版本号，吞掉错误返回一个空回执与成功在正文上不可分辨。
func orgWrite(
	c *gin.Context, call orgWriteFunc, kind, syncID string, fields map[string]any,
) (*api.OrgWriteResponse, error) {
	res, err := call(c.Request.Context(), workspace_svc.OrgWriteInput{
		UserID: ginctx.UserID(c), Kind: kind, SyncID: syncID, Fields: fields,
	})
	if err != nil {
		return nil, err
	}
	return &api.OrgWriteResponse{SyncID: res.SyncID, Version: res.Version}, nil
}

// putString / putInt 只在字段真的出现在请求里（指针非 nil）时才写进 map：没写进去
// 的键 service 就不会覆盖，载荷里的原值因此活着。空串是一个**有意义**的值
// （「取消归属」「清掉负责人」），所以判的是 nil 而不是零值。
func putString(m map[string]any, key string, v *string) {
	if v != nil {
		m[key] = *v
	}
}

func putInt(m map[string]any, key string, v *int) {
	if v != nil {
		m[key] = *v
	}
}

func departmentFields(f api.DepartmentFields) map[string]any {
	m := make(map[string]any, 7)
	putString(m, "name", f.Name)
	putString(m, "description", f.Description)
	putString(m, "icon", f.Icon)
	putString(m, "accent_color", f.AccentColor)
	putString(m, "parent_sync_id", f.ParentSyncID)
	putString(m, "lead_agent_sync_id", f.LeadAgentSyncID)
	return m
}

func agentFields(f api.AgentFields) map[string]any {
	m := make(map[string]any, 9)
	putString(m, "name", f.Name)
	putString(m, "description", f.Description)
	putString(m, "avatar_color", f.AvatarColor)
	putString(m, "avatar_icon", f.AvatarIcon)
	putString(m, "department_sync_id", f.DepartmentSyncID)
	putString(m, "parent_agent_sync_id", f.ParentAgentSyncID)
	putString(m, "prompt_json", f.PromptJSON)
	putString(m, "tools_json", f.ToolsJSON)
	return m
}

func projectFields(f api.ProjectFields) map[string]any {
	m := make(map[string]any, 6)
	putString(m, "name", f.Name)
	putString(m, "description", f.Description)
	putString(m, "icon", f.Icon)
	putString(m, "color", f.Color)
	putString(m, "parent_sync_id", f.ParentSyncID)
	putInt(m, "sort_order", f.SortOrder)
	return m
}

func execTargetFields(f api.ExecTargetFields) map[string]any {
	m := make(map[string]any, 4)
	putString(m, "agent_sync_id", f.AgentSyncID)
	putString(m, "backend_sync_id", f.BackendSyncID)
	putInt(m, "sort_order", f.SortOrder)
	putString(m, "skills_json", f.SkillsJSON)
	return m
}

// ---------- 部门 ----------

func (w *Workspace) CreateDepartment(
	c *gin.Context, req *api.CreateDepartmentRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().CreateOrgObject,
		sync_entity.KindDepartment, "", departmentFields(req.DepartmentFields))
}

func (w *Workspace) UpdateDepartment(
	c *gin.Context, req *api.UpdateDepartmentRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().UpdateOrgObject,
		sync_entity.KindDepartment, req.SyncID, departmentFields(req.DepartmentFields))
}

func (w *Workspace) DeleteDepartment(
	c *gin.Context, req *api.DeleteDepartmentRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().DeleteOrgObject,
		sync_entity.KindDepartment, req.SyncID, nil)
}

// ---------- Agent ----------

func (w *Workspace) CreateAgent(
	c *gin.Context, req *api.CreateAgentRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().CreateOrgObject,
		sync_entity.KindAgent, "", agentFields(req.AgentFields))
}

func (w *Workspace) UpdateAgent(
	c *gin.Context, req *api.UpdateAgentRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().UpdateOrgObject,
		sync_entity.KindAgent, req.SyncID, agentFields(req.AgentFields))
}

func (w *Workspace) DeleteAgent(
	c *gin.Context, req *api.DeleteAgentRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().DeleteOrgObject,
		sync_entity.KindAgent, req.SyncID, nil)
}

// ---------- 执行目标 ----------

func (w *Workspace) CreateExecTarget(
	c *gin.Context, req *api.CreateExecTargetRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().CreateOrgObject,
		sync_entity.KindAgentExecTarget, "", execTargetFields(req.ExecTargetFields))
}

func (w *Workspace) UpdateExecTarget(
	c *gin.Context, req *api.UpdateExecTargetRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().UpdateOrgObject,
		sync_entity.KindAgentExecTarget, req.SyncID, execTargetFields(req.ExecTargetFields))
}

func (w *Workspace) DeleteExecTarget(
	c *gin.Context, req *api.DeleteExecTargetRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().DeleteOrgObject,
		sync_entity.KindAgentExecTarget, req.SyncID, nil)
}

// ---------- 项目（规格 2026-08-20「项目在 web 上成为一件可管理的事」）----------

func (w *Workspace) CreateProject(
	c *gin.Context, req *api.CreateProjectRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().CreateOrgObject,
		sync_entity.KindProject, "", projectFields(req.ProjectFields))
}

func (w *Workspace) UpdateProject(
	c *gin.Context, req *api.UpdateProjectRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().UpdateOrgObject,
		sync_entity.KindProject, req.SyncID, projectFields(req.ProjectFields))
}

func (w *Workspace) DeleteProject(
	c *gin.Context, req *api.DeleteProjectRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().DeleteOrgObject,
		sync_entity.KindProject, req.SyncID, nil)
}

// ---------- 项目成员 ----------
//
// 两端都是必填（binding:"required"），因此这里直接摆进 map，不走 putString 那条
// 「提到了才写」的分支：成员关系没有「只改一半」这回事。

func (w *Workspace) CreateProjectMember(
	c *gin.Context, req *api.CreateProjectMemberRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().CreateOrgObject,
		sync_entity.KindProjectAgent, "", map[string]any{
			"project_sync_id": req.ProjectSyncID,
			"agent_sync_id":   req.AgentSyncID,
		})
}

func (w *Workspace) DeleteProjectMember(
	c *gin.Context, req *api.DeleteProjectMemberRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().DeleteOrgObject,
		sync_entity.KindProjectAgent, req.SyncID, nil)
}

// ---------- 项目在某台 agentred 上的路径 ----------

// SetProjectLocation 不走 orgWrite：这一条要先按账号内自然键决定是改还是建，
// 那个判定连同「桌面端的路径不可写」都在 service（禁用按钮拦不住直接打端点的请求）。
func (w *Workspace) SetProjectLocation(
	c *gin.Context, req *api.SetProjectLocationRequest,
) (*api.OrgWriteResponse, error) {
	res, err := workspace_svc.Default().SetProjectLocation(
		c.Request.Context(), workspace_svc.SetProjectLocationInput{
			UserID:        ginctx.UserID(c),
			ProjectSyncID: req.ProjectSyncID,
			Fingerprint:   req.DeviceFingerprint,
			Path:          req.Path,
		})
	if err != nil {
		return nil, err
	}
	return &api.OrgWriteResponse{SyncID: res.SyncID, Version: res.Version}, nil
}

func (w *Workspace) DeleteProjectLocation(
	c *gin.Context, req *api.DeleteProjectLocationRequest,
) (*api.OrgWriteResponse, error) {
	return orgWrite(c, workspace_svc.Default().DeleteOrgObject,
		sync_entity.KindProjectLocation, req.SyncID, nil)
}
