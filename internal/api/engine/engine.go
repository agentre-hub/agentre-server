// Package engine 定义账号级引擎设置的浏览器与设备快照 REST 契约。
package engine

import "github.com/cago-frame/cago/server/mux"

type Model struct {
	ModelKey      string `json:"model_key"`
	ModelID       string `json:"model_id"`
	Name          string `json:"name"`
	Enabled       bool   `json:"enabled"`
	ContextWindow *int64 `json:"context_window,omitempty"`
	MaxOutput     *int64 `json:"max_output,omitempty"`
}
type Provider struct {
	ProviderKey     string  `json:"provider_key"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	BaseURL         string  `json:"base_url"`
	MaskedTail      string  `json:"masked_tail"`
	DefaultModelKey string  `json:"default_model_key"`
	Enabled         bool    `json:"enabled"`
	Models          []Model `json:"models"`
}
type providerFields struct {
	Name            *string  `json:"name" binding:"omitempty,max=255"`
	Type            *string  `json:"type" binding:"omitempty,max=64"`
	BaseURL         *string  `json:"base_url" binding:"omitempty,max=2000"`
	APIKey          *string  `json:"api_key" binding:"omitempty,max=65535"`
	DefaultModelKey *string  `json:"default_model_key" binding:"omitempty,max=255"`
	Models          *[]Model `json:"models"`
	Enabled         *bool    `json:"enabled"`
}
type ListProvidersRequest struct {
	mux.Meta `path:"/v1/engine/providers" method:"GET"`
}
type ListProvidersResponse struct {
	Providers []Provider `json:"providers"`
}
type CreateProviderRequest struct {
	mux.Meta `path:"/v1/engine/providers" method:"POST"`
	providerFields
}
type UpdateProviderRequest struct {
	mux.Meta    `path:"/v1/engine/providers/:provider_key" method:"PATCH"`
	ProviderKey string `uri:"provider_key" binding:"required,max=255"`
	providerFields
}
type DeleteProviderRequest struct {
	mux.Meta    `path:"/v1/engine/providers/:provider_key" method:"DELETE"`
	ProviderKey string `uri:"provider_key" binding:"required,max=255"`
}
type CLIByDevice struct {
	Fingerprint string `json:"fingerprint"`
	Status      string `json:"status"`
}
type Backend struct {
	SyncID      string `json:"sync_id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	ProviderKey string `json:"provider_key"`
	ModelKey    string `json:"model_key"`
	ModelRoutes string `json:"model_routes"`
	Sandbox     string `json:"sandbox"`
	Approval    string `json:"approval"`
	// EnvJSON 是这条后端的透传环境变量表（JSON 文本）。它**刻意**下发浏览器：控制台
	// 与桌面端用同一个编辑器，读得到才编辑得动。api_key 与 cli_path 没有跟着松，
	// 见 guard_test.go。
	EnvJSON               string        `json:"env_json"`
	ReasoningEffort       string        `json:"reasoning_effort"`
	DefaultPermissionMode string        `json:"default_permission_mode"`
	DefaultModel          string        `json:"default_model"`
	OpenClawGatewayURL    string        `json:"openclaw_gateway_url"`
	OpenClawAgentID       string        `json:"openclaw_agent_id"`
	OpenClawDefaultModel  string        `json:"openclaw_default_model"`
	OpenClawSessionMode   string        `json:"openclaw_session_mode"`
	RefCount              int           `json:"ref_count"`
	CLIByDevice           []CLIByDevice `json:"cli_by_device"`
	// DeviceID 是这个后端的运行设备指纹（决策 5：必填）。它是 sync_objects 既有列
	// agentred_fingerprint 的镜像，不是 agent_backend 载荷里的一个键。
	DeviceID string `json:"device_id"`
}
type backendFields struct {
	Name        *string `json:"name" binding:"omitempty,max=255"`
	Type        *string `json:"type" binding:"omitempty,max=64"`
	ProviderKey *string `json:"provider_key" binding:"omitempty,max=255"`
	ModelKey    *string `json:"model_key" binding:"omitempty,max=255"`
	ModelRoutes *string `json:"model_routes" binding:"omitempty,max=65535"`
	Sandbox     *string `json:"sandbox" binding:"omitempty,max=255"`
	Approval    *string `json:"approval" binding:"omitempty,max=255"`
	// EnvJSON 缺省即不改：整表覆写只在浏览器显式送来这个字段时发生，
	// 只换设备之类的 PATCH 不会顺手抹掉用户存着的表（engine_svc.applyBackend）。
	EnvJSON               *string `json:"env_json" binding:"omitempty,max=65535"`
	ReasoningEffort       *string `json:"reasoning_effort" binding:"omitempty,max=255"`
	DefaultPermissionMode *string `json:"default_permission_mode" binding:"omitempty,max=255"`
	DefaultModel          *string `json:"default_model" binding:"omitempty,max=255"`
	OpenClawGatewayURL    *string `json:"openclaw_gateway_url" binding:"omitempty,max=2000"`
	OpenClawAgentID       *string `json:"openclaw_agent_id" binding:"omitempty,max=255"`
	OpenClawDefaultModel  *string `json:"openclaw_default_model" binding:"omitempty,max=255"`
	OpenClawSessionMode   *string `json:"openclaw_session_mode" binding:"omitempty,max=255"`
	CLIPath               *string `json:"cli_path"`
	// DeviceID 必填（决策 5）；required 校验落在服务层，好让 CLIPath / builtin 各自的
	// 专属错误码优先命中，就地留空只在这里过 max 长度。
	DeviceID *string `json:"device_id" binding:"omitempty,max=128"`
}
type ListBackendsRequest struct {
	mux.Meta `path:"/v1/engine/backends" method:"GET"`
}
type ListBackendsResponse struct {
	Backends []Backend `json:"backends"`
}
type CreateBackendRequest struct {
	mux.Meta `path:"/v1/engine/backends" method:"POST"`
	backendFields
}
type UpdateBackendRequest struct {
	mux.Meta `path:"/v1/engine/backends/:sync_id" method:"PATCH"`
	SyncID   string `uri:"sync_id" binding:"required,max=255"`
	backendFields
}
type DeleteBackendRequest struct {
	mux.Meta `path:"/v1/engine/backends/:sync_id" method:"DELETE"`
	SyncID   string `uri:"sync_id" binding:"required,max=255"`
}

// AddBackendIsSandboxRequest 给这条后端补 IS_SANDBOX=1。
//
// **请求体里没有、也不会有 env 表。** 浏览器读不到 env_json（R19），也就无从把
// 合并后的整表发回来；这个接口因此只收 sync_id，合并全在服务端做。写死一个键而不是
// 开一个「设置任意 env」的口子，是为了让「浏览器不参与 env_json 的内容」这条继续
// 在类型层成立。
type AddBackendIsSandboxRequest struct {
	mux.Meta `path:"/v1/engine/backends/:sync_id/is-sandbox" method:"POST"`
	SyncID   string `uri:"sync_id" binding:"required,max=255"`
}
type CLIOverlay struct {
	BackendSyncID string `json:"backend_sync_id"`
	Fingerprint   string `json:"fingerprint"`
	Status        string `json:"status"`
}
type ListCLIOverlaysRequest struct {
	mux.Meta `path:"/v1/engine/cli-overlays" method:"GET"`
}
type ListCLIOverlaysResponse struct {
	Overlays []CLIOverlay `json:"overlays"`
}
type SnapshotProvider struct {
	ProviderKey     string  `json:"provider_key"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	BaseURL         string  `json:"base_url"`
	APIKey          string  `json:"api_key"`
	DefaultModelKey string  `json:"default_model_key"`
	Models          []Model `json:"models"`
}
type SnapshotCLIOverlay struct {
	BackendSyncID string `json:"backend_sync_id"`
	CLIPath       string `json:"cli_path"`
}
type SnapshotRequest struct {
	mux.Meta `path:"/v1/engine/snapshot" method:"GET"`
}
type SnapshotResponse struct {
	Providers   []SnapshotProvider   `json:"providers"`
	CLIOverlays []SnapshotCLIOverlay `json:"cli_overlays"`
}
