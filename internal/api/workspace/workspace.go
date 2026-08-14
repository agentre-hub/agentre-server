// Package workspace 定义 web 控制台两屏（总览页、设备展开）用到的只读端点。
//
// R19：这里的每一个响应结构体都不带项目路径、CLIPath 或 EnvJSON 字段——不是靠
// 调用方注意不填，而是这些字段在 workspace_svc 的视图对象里根本不存在。
package workspace

import "github.com/cago-frame/cago/server/mux"

// ---------- 总览页：账号级 Agent 清单 ----------

// ListAgentsRequest 取总览页的账号级 Agent 清单。DeviceFingerprint 是**调用方自己**
// 的设备指纹（可空）：这组端点鉴权的是用户不是设备，所以调用方要按哪台设备的顺序
// 看这条链只能由参数说明；缺失或解析不到设备时按账号顺序返回，不报错（决策 9 读侧）。
type ListAgentsRequest struct {
	mux.Meta          `path:"/v1/workspace/agents" method:"GET"`
	DeviceFingerprint string `form:"device_fingerprint"`
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
	// Availability 是 available / offline / unpaired / skipped_for_web 之一。
	Availability string `json:"availability"`
	Current      bool   `json:"current"`
}

type AgentItem struct {
	SyncID             string           `json:"sync_id"`
	Name               string           `json:"name"`
	AvatarColor        string           `json:"avatar_color,omitempty"`
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
	// DeviceFingerprint 是调用方自己的设备指纹（可空）：带上时执行目标链先按这台
	// 设备自己的排列重排，再走「取第一个可用」的挑选，Chosen 与逐档原因随之改变。
	DeviceFingerprint string `form:"device_fingerprint"`
}

type DispatchTierItem struct {
	Rank int `json:"rank"`
	// BackendSyncID 见 ExecTargetItem.BackendSyncID：浏览器表达排列的唯一锚点。
	BackendSyncID string `json:"backend_sync_id,omitempty"`
	DeviceID      int64  `json:"device_id,omitempty"`
	DeviceName    string `json:"device_name,omitempty"`
	BackendType   string `json:"backend_type,omitempty"`
	// Kind 是这一档指向的设备种类（desktop / agentred）。R17 发起前据此如实说明
	// org/subagent/hook 在目标上是否可用；无设备的档（本机相对 / 未配对）不带它。
	Kind string `json:"kind,omitempty"`
	// Availability 是 available / offline / unpaired / skipped_for_web /
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

// SetExecTargetOrderRequest 保存「调用方这台设备把某个 Agent 的执行目标排成这个
// 次序」。账号取自鉴权上下文；设备指纹只能由参数传入（这组端点鉴权的是用户不是
// 设备），服务端按 (user_id, fingerprint) 解析出设备行，解析不到即拒绝（决策 9）。
//
// 排列用 backend sync_id 数组表达，不用 rank：rank 是位置性的，device_id 也不唯一。
// 它是收敛的偏好而非权威——指向已删 backend 的项在解析时忽略，因此这里不校验它与
// 当前执行目标集合是否一致。
type SetExecTargetOrderRequest struct {
	mux.Meta          `path:"/v1/workspace/exec-target-order" method:"POST"`
	DeviceFingerprint string `json:"device_fingerprint" binding:"required,min=8,max=128"`
	AgentSyncID       string `json:"agent_sync_id" binding:"required,max=255"`
	// BackendSyncIDs 允许为空数组（等价于「这台设备不再有自己的顺序偏好」）。
	BackendSyncIDs []string `json:"backend_sync_ids" binding:"max=64,dive,required,max=255"`
}

type SetExecTargetOrderResponse struct{}
