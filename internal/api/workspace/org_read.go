package workspace

import "github.com/cago-frame/cago/server/mux"

// ---------- 组织面的读通道（规格 2026-08-18「server 端的组织管理面」）----------
//
// 浏览器仅凭会话就要读到索引与详情要画的全部材料：部门（含空部门与父子关系）、
// Agent 的完整组织字段、每档执行目标（含技能），以及配一档时能挑哪些后端。
// 账号一律取自鉴权上下文，请求里没有任何身份字段——跨账号因此读不到。
//
// **这里的每一个结构体都没有能装下 cli_path / env_json 的字段。** 守法与写方向
// 同源、与 AgentView 同源：不是序列化时过滤，而是类型上就没有那个字段。
// 后端清单（OrgBackendItem）是这条红线上最吃紧的一处——它专门用来呈现后端，
// 而后端的同步载荷里就摆着那两个键。守卫见 guard_test.go。

// OrgChartRequest 一次取回组织面的全部材料。索引与详情画的是同一份数据，选中哪一行
// 不需要再问一次；账号级实时通道推来版本推进时，重取的也是这一份。
type OrgChartRequest struct {
	mux.Meta `path:"/v1/workspace/org" method:"GET"`
}

// OrgDepartmentItem 是索引上的一个组头。**一个 Agent 都没有的部门照常在场**：
// 按「有 Agent 的部门」反推组头会让空部门从界面上整个消失，用户也就再拖不进去东西。
type OrgDepartmentItem struct {
	SyncID      string `json:"sync_id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`
	AccentColor string `json:"accent_color,omitempty"`
	// ParentSyncID 为空即根部门；组头按它递归缩进。
	ParentSyncID string `json:"parent_sync_id,omitempty"`
	// LeadAgentSyncID 是组头上标的负责人。
	LeadAgentSyncID string `json:"lead_agent_sync_id,omitempty"`
	SortOrder       int    `json:"sort_order"`
}

// OrgExecTargetItem 是详情「执行」栏的一档（一档一行，技能折在行内）。
type OrgExecTargetItem struct {
	// SyncID 是这一档自己的同步标识：改技能授权、删掉这一档都按它定位
	// （BackendSyncID 指的是它引用的后端，不是它自己）。
	SyncID        string `json:"sync_id"`
	Rank          int    `json:"rank"`
	BackendSyncID string `json:"backend_sync_id,omitempty"`
	BackendName   string `json:"backend_name,omitempty"`
	BackendType   string `json:"backend_type,omitempty"`
	DeviceID      int64  `json:"device_id,omitempty"`
	DeviceName    string `json:"device_name,omitempty"`
	// DeviceFingerprint 是这一档所在那台机器的 agentred 指纹。浏览器的中继是
	// 点对点的（`/v1/relay/client?daemon_fingerprint=…` 认指纹，不认 device_id），
	// 没有它就拨不到这一档去问「这个后端上装了哪些技能包」。
	//
	// 指纹是**机器的身份**，不是「机器上的东西」——它不是路径、不是凭据，R19 守的
	// 是后者。同一个值已经随 `GET /v1/devices` 与派发计划（DispatchChoiceItem）
	// 下行给同一个浏览器会话，这里不是新开的口子。
	//
	// 没写运行设备的档与「后端已不在」的档留空：前者没指到任何一台机器 / 后者不知道
	// 是哪台机器，都不编一个。离线的档照带——离线只是此刻拨不通。
	DeviceFingerprint string `json:"device_fingerprint,omitempty"`
	// IsLocalReference 为真即这一档指向的后端行没写运行设备（决策 14 的存量）：如实
	// 标出而不是从列表里抹掉——不可用的档留在列表里并给出原因。字段名是旧的，含义
	// 见 workspace_svc.OrgBackendView.IsLocalReference。
	IsLocalReference bool `json:"is_local_reference"`
	// Availability 与总览页同一套取值：available / offline / unpaired / no_device。
	Availability string `json:"availability"`
	// Current 标记当前生效的那一档，至多一档为 true。
	Current bool `json:"current"`
	// SkillsJSON 是这一档的技能授权（R15e），桌面端定义的 JSON 字符串，原样搬运。
	SkillsJSON string `json:"skills_json,omitempty"`
}

// OrgAgentItem 是索引的一行，同时是详情要编辑的那一份字段集合（规格「详情」：
// 与桌面端一致，没有新增也没有删除）。字段与写方向的 AgentFields 一一对应，
// 多出的两个只读键是 SyncID 与 SystemBadge。
type OrgAgentItem struct {
	SyncID      string `json:"sync_id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	AvatarColor string `json:"avatar_color,omitempty"`
	AvatarIcon  string `json:"avatar_icon,omitempty"`
	// SystemBadge 非空即系统 Agent（唯一合法的「既不属于部门也没有上级」），索引把
	// 它单独置顶一行。web 上只读：写通道里没有这个键。
	SystemBadge string `json:"system_badge,omitempty"`
	// DepartmentSyncID 与 ParentAgentSyncID 是归属的二选一，两个都如实带出：详情的
	// 归属下拉靠它们决定自己停在哪一组上。
	DepartmentSyncID  string `json:"department_sync_id,omitempty"`
	ParentAgentSyncID string `json:"parent_agent_sync_id,omitempty"`
	SortOrder         int    `json:"sort_order"`
	// PromptJSON / ToolsJSON 是详情「行为」栏的两份 JSON 字符串（系统提示词与工具
	// 授权），桌面端定义、这一侧只搬运不解析。它们是 web 组织面本来就管的字段——
	// 写方向同样收得下（见 org.go 的 AgentFields）。
	PromptJSON  string              `json:"prompt_json,omitempty"`
	ToolsJSON   string              `json:"tools_json,omitempty"`
	ExecTargets []OrgExecTargetItem `json:"exec_targets"`
}

type OrgChartResponse struct {
	Departments []OrgDepartmentItem `json:"departments"`
	Agents      []OrgAgentItem      `json:"agents"`
}

// OrgBackendsRequest 取「配一档执行目标时能挑哪个后端」的清单。
//
// **这条路径上只有 GET。** 后端是设备级对象，浏览器不能新建也不能编辑它，
// 只能从已有的里挑一个去配执行目标（org.go 顶部与 guard_test.go 各守一道）。
type OrgBackendsRequest struct {
	mux.Meta `path:"/v1/workspace/org/backends" method:"GET"`
}

// OrgBackendItem 是后端清单里的一项：只有「指向」与「在哪台机器上、此刻能不能用」。
//
// 浏览器要能挑一个后端，却不该知道那台机器上的可执行文件在哪、更不该知道用户往里
// 塞了什么环境变量——这个类型因此没有任何一个字段能装下 cli_path 或 env_json。
type OrgBackendItem struct {
	SyncID           string `json:"sync_id"`
	Name             string `json:"name,omitempty"`
	BackendType      string `json:"backend_type,omitempty"`
	DeviceID         int64  `json:"device_id,omitempty"`
	DeviceName       string `json:"device_name,omitempty"`
	IsLocalReference bool   `json:"is_local_reference"`
	Availability     string `json:"availability"`
}

type OrgBackendsResponse struct {
	Backends []OrgBackendItem `json:"backends"`
}
