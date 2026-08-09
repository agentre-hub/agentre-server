// Package workspace 定义 web 控制台两屏（总览页、设备展开）用到的只读端点。
//
// R19：这里的每一个响应结构体都不带项目路径、CLIPath 或 EnvJSON 字段——不是靠
// 调用方注意不填，而是这些字段在 workspace_svc 的视图对象里根本不存在。
package workspace

import "github.com/cago-frame/cago/server/mux"

// ---------- 总览页：账号级 Agent 清单 ----------

type ListAgentsRequest struct {
	mux.Meta `path:"/v1/workspace/agents" method:"GET"`
}

type ExecTargetItem struct {
	Rank             int    `json:"rank"`
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
