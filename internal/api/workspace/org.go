package workspace

import "github.com/cago-frame/cago/server/mux"

// ---------- 组织面的写通道（规格 2026-08-18「server 端的组织管理面」）----------
//
// 浏览器 → 这些端点 → server 直写 sync_objects。账号一律取自鉴权上下文，**请求体里
// 没有任何身份字段**，跨账号因此写不进去。
//
// 每一族三个端点：建（`/…`）、改（`/…/update`）、删（`/…/delete`）。改与删都走 POST
// 而不是 PUT/DELETE，与隔壁 /v1/saved-sessions 那一族保持同一种形状。
//
// **可写的只有部门、Agent、执行目标。** agent_backend 不在其中，而且这里连一个能
// 写它的请求结构体都没有：它是设备级对象，载荷里带 cli_path 与 env_json（本机可执行
// 文件路径与透传环境变量），浏览器无从知道那台机器上的可执行文件在哪，新建出来的档
// 必然不可用。web 上能做的是**从已有后端里挑一个**去配执行目标——那正是
// ExecTargetFields.BackendSyncID 这个引用。守卫见 guard_test.go。
//
// **指针 = 「这次请求没提到这个键」。** 服务端据此只覆盖明确涉及的键，载荷里其余的
// 原值原样留下（sync_objects 是整行 last-write-wins，把没提到的键一起写成零值就是
// 静默的数据丢失）。省略与显式传 null 在这里是同一件事：都不改。

// OrgWriteResponse 是九个写端点共用的回执：新建时的同步标识由 server 分配，
// 版本号是这次写入吃掉的那一个（浏览器可据此与实时通道推来的版本对齐）。
type OrgWriteResponse struct {
	SyncID  string `json:"sync_id"`
	Version int64  `json:"version"`
}

// ---------- 部门 ----------

// DepartmentFields 是浏览器能写的部门键，建与改共用。
type DepartmentFields struct {
	Name        *string `json:"name" binding:"omitempty,max=255"`
	Description *string `json:"description" binding:"omitempty,max=2000"`
	Icon        *string `json:"icon" binding:"omitempty,max=64"`
	AccentColor *string `json:"accent_color" binding:"omitempty,max=32"`
	// ParentSyncID 为空串即挂到根上；不传则不动原来的归属。
	ParentSyncID *string `json:"parent_sync_id" binding:"omitempty,max=255"`
	// LeadAgentSyncID 是部门负责人（组头上的 Lead），为空串即没有负责人。
	LeadAgentSyncID *string `json:"lead_agent_sync_id" binding:"omitempty,max=255"`
	// 排序不在其中：规格只把「排序」给了执行目标（「web 组织面能管的是」那一条），
	// 部门与 Agent 的次序这一轮浏览器不动。
}

// CreateDepartmentRequest 建一个部门。name 必填由 service 判（它同时是设备上行那条
// 路径的判据），其余键不传即不写。
type CreateDepartmentRequest struct {
	mux.Meta `path:"/v1/workspace/org/departments" method:"POST"`
	DepartmentFields
}

type UpdateDepartmentRequest struct {
	mux.Meta `path:"/v1/workspace/org/departments/update" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
	DepartmentFields
}

type DeleteDepartmentRequest struct {
	mux.Meta `path:"/v1/workspace/org/departments/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}

// ---------- Agent ----------

// AgentFields 是浏览器能写的 Agent 键：名称、简介、头像与配色、归属、系统提示词、
// 工具授权（规格列明的那一份）。**LLM 供应商凭据不在其中**（决策 24：它只住在那台
// 机器上），头像正文也不在——头像按内容哈希单独传，不进同步载荷。
type AgentFields struct {
	Name        *string `json:"name" binding:"omitempty,max=255"`
	Description *string `json:"description" binding:"omitempty,max=2000"`
	AvatarColor *string `json:"avatar_color" binding:"omitempty,max=32"`
	AvatarIcon  *string `json:"avatar_icon" binding:"omitempty,max=64"`
	// DepartmentSyncID 为空串即不属于任何部门（索引里的「自由 Agent」）。
	DepartmentSyncID *string `json:"department_sync_id" binding:"omitempty,max=255"`
	// ParentAgentSyncID 是行内「↳ 主管」那条显式汇报关系，为空串即回到按部门推导。
	ParentAgentSyncID *string `json:"parent_agent_sync_id" binding:"omitempty,max=255"`
	// PromptJSON / ToolsJSON 是桌面端定义的两份 JSON 字符串，这一侧只搬运不解析
	// ——解析它就等于在两个仓库里各维护一份同一个结构。
	PromptJSON *string `json:"prompt_json" binding:"omitempty,max=65535"`
	ToolsJSON  *string `json:"tools_json" binding:"omitempty,max=65535"`
}

type CreateAgentRequest struct {
	mux.Meta `path:"/v1/workspace/org/agents" method:"POST"`
	AgentFields
}

type UpdateAgentRequest struct {
	mux.Meta `path:"/v1/workspace/org/agents/update" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
	AgentFields
}

type DeleteAgentRequest struct {
	mux.Meta `path:"/v1/workspace/org/agents/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}

// ---------- 执行目标 ----------

// ExecTargetFields 是浏览器能写的执行目标键。
//
// BackendSyncID 是**引用**：web 上挑的是账号里已有的后端，建不出新的（见包顶部）。
// 服务端会核对它确实是一个存活的 agent_backend，引用不到就当场拒绝。
//
// 整条链的次序另有 POST /v1/workspace/exec-target-order 一次性表达（决策 14 的账号
// 默认顺序）；这里的 SortOrder 只是新增一档时它落在第几位。
type ExecTargetFields struct {
	AgentSyncID   *string `json:"agent_sync_id" binding:"omitempty,max=255"`
	BackendSyncID *string `json:"backend_sync_id" binding:"omitempty,max=255"`
	SortOrder     *int    `json:"sort_order" binding:"omitempty,min=0,max=100000"`
	// SkillsJSON 是这一档的技能授权（R15e），同样是桌面端定义的 JSON 字符串。
	SkillsJSON *string `json:"skills_json" binding:"omitempty,max=65535"`
}

type CreateExecTargetRequest struct {
	mux.Meta `path:"/v1/workspace/org/exec-targets" method:"POST"`
	ExecTargetFields
}

type UpdateExecTargetRequest struct {
	mux.Meta `path:"/v1/workspace/org/exec-targets/update" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
	ExecTargetFields
}

type DeleteExecTargetRequest struct {
	mux.Meta `path:"/v1/workspace/org/exec-targets/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}

// ---------- 项目（规格 2026-08-20「项目在 web 上成为一件可管理的事」）----------
//
// 项目一族与上面三族走的是同一条写通道、同一套指针语义、同一个回执。加进来的理由与
// 排除 agent_backend 的理由是同一条判据的两面：这几个键**全是「指向」**——名字、
// 图标、颜色、简介、父项目、排序，没有任何一件是机器上的东西。
//
// **这里没有 path，也不会有。** 项目的绝对路径不是项目自己的字段：它按
// 「项目 × 那台 agentred」逐条存在 project_location 上，另有自己的入口。

// ProjectFields 是浏览器能写的项目键，建与改共用。取值与桌面端一一对应
// （project_entity.Project 上那几个可编辑字段），没有新增也没有删除。
type ProjectFields struct {
	Name        *string `json:"name" binding:"omitempty,max=255"`
	Description *string `json:"description" binding:"omitempty,max=2000"`
	Icon        *string `json:"icon" binding:"omitempty,max=64"`
	// Color 取桌面端 project_entity.allowedColors 那一套（agent-1…16 与 neutral）：
	// 项目树是从桌面端同步上来的，服务端必须认它那份色板。
	Color *string `json:"color" binding:"omitempty,max=32"`
	// ParentSyncID 为空串即挂到根上；不传则不动原来的归属。指向自己或自己的后代时
	// service 就地拒绝——环会让两端的项目树递归缩进永不终止。
	ParentSyncID *string `json:"parent_sync_id" binding:"omitempty,max=255"`
	SortOrder    *int    `json:"sort_order" binding:"omitempty,min=0,max=100000"`
}

// CreateProjectRequest 建一个项目。**路径不是必填**（决策 7）：在 web 上建项目的人
// 可能一台 agentred 都还没在线，挡住他等于把「只有 agentred 也能管理」堵在第一步。
// 代价是这样建出来的项目在配好路径之前开不出对话，界面据此挂「未配置」角标。
type CreateProjectRequest struct {
	mux.Meta `path:"/v1/workspace/org/projects" method:"POST"`
	ProjectFields
}

type UpdateProjectRequest struct {
	mux.Meta `path:"/v1/workspace/org/projects/update" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
	ProjectFields
}

// DeleteProjectRequest 删一个项目。子项目、以及这整棵子树名下的成员关系与路径记录
// 一并落墓碑（决策 13）；**对话一条都不删**——项目归属是判出来的，项目行没了那些
// 对话自然回到「未归项目」。
type DeleteProjectRequest struct {
	mux.Meta `path:"/v1/workspace/org/projects/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}

// ---------- 项目成员 ----------
//
// **只有建与删，没有改。** 一条成员关系要么在、要么不在，没有可改的内容（桌面端
// projectAgentAdapter.apply 的同一句话）。

// CreateProjectMemberRequest 把一个 Agent 加进一个项目。两端都用同步标识表达；
// 两端必须都是账号里存活的对象，同一个 Agent 也不重复入同一个项目，service 各判一道。
type CreateProjectMemberRequest struct {
	mux.Meta      `path:"/v1/workspace/org/project-members" method:"POST"`
	ProjectSyncID string `json:"project_sync_id" binding:"required,max=255"`
	AgentSyncID   string `json:"agent_sync_id" binding:"required,max=255"`
}

// DeleteProjectMemberRequest 按**这条成员关系自己的**同步标识删掉它，不是按 Agent 的
// ——同一个 Agent 可以是好几个项目的成员，按 Agent 删说不清删的是哪一个项目里的。
type DeleteProjectMemberRequest struct {
	mux.Meta `path:"/v1/workspace/org/project-members/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}

// ---------- 项目在某台 agentred 上的路径 ----------
//
// **只有 agentred 的路径写得进去**（决策 4）。桌面端的本机路径不是同一份数据：它
// 住在上报组 device_local_paths、按上报设备分命名空间、整份快照替换——从 web 写一行
// 进去，下一次那台桌面端上报就把它冲掉了。给它一个按钮 = 给一个按了不生效的按钮。
// 因此这里带的是**目标机器的指纹**而不是 device_id，服务端再据指纹核对它确实是一台
// agentred。

// SetProjectLocationRequest 把这个项目在这台 agentred 上的路径设成这个。
//
// 没有单独的「改」：账号内自然键是（项目同步标识, 指纹），服务端按它先找存活的那一行，
// 有就改、没有就建，因此同一台机器上同一个项目永远只有一行——(账号, 项目, 指纹) 上
// 有一个部分唯一索引，第二行会直接撞库。
type SetProjectLocationRequest struct {
	mux.Meta          `path:"/v1/workspace/org/project-locations" method:"POST"`
	ProjectSyncID     string `json:"project_sync_id" binding:"required,max=255"`
	DeviceFingerprint string `json:"device_fingerprint" binding:"required,max=255"`
	// Path 是那台机器上的绝对路径。**空目录照样是一个正当的项目根**，因此这里不做
	// 「里面得有东西」这类判断；它存不存在由那台机器自己知道（目录选择器点着选，
	// 就是为了不让人背下来再敲）。
	Path string `json:"path" binding:"required,max=4096"`
}

// DeleteProjectLocationRequest 移除一条路径记录。删的只是「这台机器上这个项目在哪」
// 这条记录，**机器上的代码目录一个字节都不动**。
type DeleteProjectLocationRequest struct {
	mux.Meta `path:"/v1/workspace/org/project-locations/delete" method:"POST"`
	SyncID   string `json:"sync_id" binding:"required,max=255"`
}
