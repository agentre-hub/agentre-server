// Package workspace 定义 web 控制台两屏（总览页、设备展开）用到的只读端点。
//
// R19：这里的每一个响应结构体都不带项目路径、CLIPath 或 EnvJSON 字段——不是靠
// 调用方注意不填，而是这些字段在 workspace_svc 的视图对象里根本不存在。
package workspace

import "github.com/cago-frame/cago/server/mux"

// ---------- 总览页：账号级 Agent 清单 ----------

// ListAgentsRequest 取总览页的账号级 Agent 清单。执行目标链按账号默认顺序
// （sync_objects 里的 sort_order）返回 —— 浏览器排的也是它，没有按浏览器区分的
// 那一层（决策 14），因此这里不需要任何调用方标识。
type ListAgentsRequest struct {
	mux.Meta `path:"/v1/workspace/agents" method:"GET"`
}

type ExecTargetItem struct {
	Rank int `json:"rank"`
	// BackendSyncID 是这一档跨机稳定且逐档唯一的标识，浏览器靠它表达排列：rank 是
	// 位置性的（重排后就变了），device_id 也不唯一（一台机器可挂多个 backend）。
	BackendSyncID    string `json:"backend_sync_id,omitempty"`
	IsLocalReference bool   `json:"is_local_reference"`
	DeviceID         int64  `json:"device_id,omitempty"`
	DeviceName       string `json:"device_name,omitempty"`
	BackendType      string `json:"backend_type,omitempty"`
	// Availability 是 available / offline / unpaired / no_device 之一。
	Availability string `json:"availability"`
	Current      bool   `json:"current"`
}

type AgentItem struct {
	SyncID      string `json:"sync_id"`
	Name        string `json:"name"`
	AvatarColor string `json:"avatar_color,omitempty"`
	AvatarIcon  string `json:"avatar_icon,omitempty"`
	// ProjectSyncIDs 是这个 Agent 直接加入的项目。omitempty 是有意的：没加入任何
	// 项目时这个键**缺席**，不发一个空数组——浏览器那侧要分得开「它不属于任何项目」
	// 与「这一档还没实现」。继承由浏览器按项目树自己算（树在 /v1/workspace/projects）。
	ProjectSyncIDs     []string         `json:"project_sync_ids,omitempty"`
	DepartmentName     string           `json:"department_name,omitempty"`
	ExecTargets        []ExecTargetItem `json:"exec_targets"`
	HasAvailableTarget bool             `json:"has_available_target"`
}

type ListAgentsResponse struct {
	Agents []AgentItem `json:"agents"`
}

// ---------- R15 派发计划：从 web 给「某 Agent + 某项目」派活 ----------

// DispatchTargetRequest 取 R15 的派发计划。project_sync_id 可空：picker 阶段先只看
// 「这台机器能不能接活」，不传项目即不做项目路径判定；确认派发阶段带上项目，逐档
// 判定（含那台机器上没配这个项目的路径）。
type DispatchTargetRequest struct {
	mux.Meta      `path:"/v1/workspace/dispatch-target" method:"GET"`
	AgentSyncID   string `form:"agent_sync_id" binding:"required"`
	ProjectSyncID string `form:"project_sync_id"`
	// TargetBackendSyncID 可空。非空 = 用户在「在哪台机器上跑」里挑了具体一档
	// （空会话态那枚 chip，「只影响这一次」），Chosen 按那一档算而不是取第一个
	// 可用的；那一档跑不了时 Chosen 留空，**不回落**到自动挑的那一档。
	TargetBackendSyncID string `form:"target_backend_sync_id"`
}

type DispatchTierItem struct {
	Rank int `json:"rank"`
	// BackendSyncID 见 ExecTargetItem.BackendSyncID：浏览器表达排列的唯一锚点。
	BackendSyncID string `json:"backend_sync_id,omitempty"`
	DeviceID      int64  `json:"device_id,omitempty"`
	DeviceName    string `json:"device_name,omitempty"`
	BackendType   string `json:"backend_type,omitempty"`
	// Kind 是这一档指向的设备种类（desktop / agentred）。R17 发起前据此如实说明
	// org/subagent/hook 在目标上是否可用；说不出机器的档（未指定设备 / 未配对）不带它。
	Kind string `json:"kind,omitempty"`
	// Availability 是 available / offline / unpaired / no_device /
	// project_path_missing 之一。
	Availability string `json:"availability"`
	Current      bool   `json:"current"`
}

// DispatchChoiceItem 是派发最终落到的那一档（第一档可用的 agentred）。Cwd 只在
// project_sync_id 非空（确认派发阶段）时带出，供屏幕 25 呈现与派发 runtime.run；
// 这是 R19 红线在主动派活场景下的唯一例外（见 workspace_svc.WebDispatchChoice 注释）。
type DispatchChoiceItem struct {
	DeviceFingerprint string `json:"device_fingerprint"`
	DeviceID          int64  `json:"device_id"`
	DeviceName        string `json:"device_name"`
	BackendType       string `json:"backend_type"`
	// Kind 是选中目标设备种类（desktop / agentred），R17 发起前据此说明工具可用性。
	Kind string `json:"kind"`
	Cwd  string `json:"cwd,omitempty"`
}

type DispatchTargetResponse struct {
	AgentSyncID string             `json:"agent_sync_id"`
	Tiers       []DispatchTierItem `json:"tiers"`
	// Chosen 为 null = 全部档都不可用（前端逐档渲染原因，不静默失败）。
	Chosen *DispatchChoiceItem `json:"chosen"`
	// Projects 是选中的那一档机器上已配置的项目（picker 阶段挑项目用）。
	Projects []ProjectItem `json:"projects"`
}

// ---------- 设备展开 ----------

type DeviceDetailRequest struct {
	mux.Meta `path:"/v1/workspace/device-detail" method:"GET"`
	DeviceID int64 `form:"device_id" binding:"required"`
}

type RunnableAgentItem struct {
	SyncID string `json:"sync_id"`
	Name   string `json:"name"`
	Rank   int    `json:"rank"`
}

type ProjectItem struct {
	SyncID     string `json:"sync_id"`
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
}

type DeviceDetailResponse struct {
	DeviceID int64  `json:"device_id"`
	Kind     string `json:"kind"`
	// RunnableAgents 只在 Kind=="agentred" 时非空——Agent 不按桌面端归属。
	RunnableAgents []RunnableAgentItem `json:"runnable_agents,omitempty"`
	Projects       []ProjectItem       `json:"projects"`
}

// ---------- 每端自己的派发顺序 ----------

// SetExecTargetOrderRequest 保存「把某个 Agent 的执行目标排成这个次序」。改的是
// 账号默认顺序（sync_objects 里各 agent_exec_target 行的 sort_order，决策 14），
// 账号取自鉴权上下文，跨账号因此写不进去。
//
// 排列用 backend sync_id 数组表达，不用 rank：rank 是位置性的，device_id 也不唯一。
// 它是收敛的而非权威的——指向已删 backend 的项在写入时忽略，因此这里不校验它与
// 当前执行目标集合是否一致。
type SetExecTargetOrderRequest struct {
	mux.Meta    `path:"/v1/workspace/exec-target-order" method:"POST"`
	AgentSyncID string `json:"agent_sync_id" binding:"required,max=255"`
	// BackendSyncIDs 允许为空数组（等价于「这一次什么都不重排」）。
	BackendSyncIDs []string `json:"backend_sync_ids" binding:"max=64,dive,required,max=255"`
}

type SetExecTargetOrderResponse struct{}

// ---------- web 统一会话索引：项目轴的两块材料 ----------

// AccountProjectsRequest 取账号的项目树。与会话无关，因此取一次就能用很久；
// 会话摘要与它们的项目归属现在从镜像来（见 internal/api/agentsession），归属判定整个
// 在服务端就地完成，浏览器不再上送 (机器指纹, cwd) 探针——POST
// /v1/workspace/session-projects 与它的探针协议已经退役（决策 12）。
type AccountProjectsRequest struct {
	mux.Meta `path:"/v1/workspace/projects" method:"GET"`
}

// ProjectNodeItem 是项目树上的一个节点。没有路径，也没有「这台机器配没配」——
// 后者是设备展开的问题（见 ProjectItem），这里只回项目本身。
type ProjectNodeItem struct {
	SyncID string `json:"sync_id"`
	Name   string `json:"name"`
	// Icon 是项目自己选的图标，原样照抄同步载荷的 icon 键；项目从没选过时省略
	// （前端落到名字首字母那条兜底，不是服务端补一个假默认值）。
	Icon  string `json:"icon,omitempty"`
	Color string `json:"color,omitempty"`
	// Description 是项目简介，项目设置里可改。
	Description string `json:"description,omitempty"`
	// ParentSyncID 为空即根项目；索引靠它把项目递归成树。
	ParentSyncID string `json:"parent_sync_id,omitempty"`
	SortOrder    int    `json:"sort_order"`
	// Configured 为假即「一台 agentred 都没配这个项目的路径」，组头据此挂那枚可点的
	// 「未配置」角标（决策 9）。**它只是一个布尔**——路径正文在别的端点、别的地方。
	Configured bool `json:"configured"`
	// Members 是这个项目的直接成员。组头的 ＋ 只列这一份（规格 2026-08-20 决策 10）：
	// 它问的是「在这个项目里开对话」，不是「挑一个 Agent」。继承来的成员不在其中
	// ——那一档在桌面端就是只读的，删不掉的东西不该长成能删的样子。
	Members []ProjectMemberItem `json:"members,omitempty"`
}

// ProjectMemberItem 是项目的一个直接成员。SyncID 是**这条成员关系自己的**同步标识：
// 删一个成员删的是这条关系那一行，浏览器没有它就定位不到要删哪一行。
type ProjectMemberItem struct {
	SyncID      string `json:"sync_id"`
	AgentSyncID string `json:"agent_sync_id"`
}

type AccountProjectsResponse struct {
	Projects []ProjectNodeItem `json:"projects"`
}

// ---------- 项目设置：机器与路径（规格 2026-08-20「路径与 R19」）----------

// ProjectMachinesRequest 取「这个项目在每台机器上落在哪」。
type ProjectMachinesRequest struct {
	mux.Meta      `path:"/v1/workspace/projects/machines" method:"GET"`
	ProjectSyncID string `form:"project_sync_id" binding:"required,max=255"`
}

// ProjectMachineItem 是「机器与路径」那一节的一行。
//
// **这是 R19 唯一收窄的一处。** 它按对象收窄而不是按字段名：镜像会话的 cwd 与
// agent_backends 的 cli_path / env_json 仍然永不下发，只有这里的 Path 例外，
// 理由只有一条——用户要改的就是它，而**改不了一个看不见的值**。设备展开那一屏问的
// 是「这台机器准备好了吗」，一个布尔就够，因此 ProjectItem 至今没有这个字段。
type ProjectMachineItem struct {
	DeviceID   int64  `json:"device_id"`
	DeviceName string `json:"device_name"`
	// Kind 是 desktop / agentred。两者在这一屏上的口径完全不同，见下面各字段。
	Kind string `json:"kind"`
	// Fingerprint 是机器的身份，不是「机器上的东西」：目录选择器靠它拨中继
	// （`/v1/relay/client?daemon_fingerprint=…` 认的就是它）。同一个值已经随
	// GET /v1/devices 与派发计划下行给同一个浏览器会话，不是新开的口子。
	Fingerprint string `json:"fingerprint"`
	// Online 为假的机器**留在列表里并禁用**：隐藏会让人以为那台机器没配对。
	Online     bool `json:"online"`
	Configured bool `json:"configured"`
	// Path 是这个项目在这台机器上的路径正文，两类机器都有（规格 2026-08-21 决策 5），
	// 只是来源不同：agentred 取自同步组 project_location，桌面端取自上报组
	// device_local_paths。
	Path string `json:"path,omitempty"`
	// LocationSyncID 是这一行路径记录自己的同步标识，移除一条 agentred 路径按它定位。
	// **桌面端恒为空**：它在同步组里没有这样一行，移除得经中继喊那台机器自己去做
	// （决策 6）——服务端删不掉的东西不该长成能在这里删的样子。
	LocationSyncID string `json:"location_sync_id,omitempty"`
}

type ProjectMachinesResponse struct {
	Machines []ProjectMachineItem `json:"machines"`
}
