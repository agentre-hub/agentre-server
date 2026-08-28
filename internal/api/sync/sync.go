// Package sync 定义工作区多端同步的请求与响应结构。
//
// 载荷里不出现任何桌面端的本地自增 ID：跨机引用一律是同步标识、agentred 指纹或
// provider_key，全是字符串。载荷本身还要过 sync_entity.ValidatePayload 的守卫。
package sync

import (
	"encoding/json"

	"github.com/cago-frame/cago/server/mux"
)

// PushItem 是一次上行里的一条改动。
type PushItem struct {
	Kind   string `json:"kind"    binding:"required,max=32"`
	SyncID string `json:"sync_id" binding:"required,max=128"`
	// BaseVersion 是本端最后一次见到的同步版本号；本端新建、server 从未见过的行填 0。
	BaseVersion int64 `json:"base_version"`
	// UpdatedAt 是客户端的最后修改时间，只用于展示与 30 天窗口计算，不参与胜负。
	UpdatedAt int64 `json:"updated_at"`
	// DeletedAt 非零 = 这是一条墓碑，值是发起端记下的删除时刻（Unix 毫秒）。
	// 契约上是**时刻**而不是布尔：桌面端库、线格式与 server 库三处都是时刻，
	// 压成布尔后 server 落地只能另行编造一个删除时间
	// （2026-08-27-schema-overhaul.md 决策 20）。
	DeletedAt           int64           `json:"deleted_at"`
	AgentredFingerprint string          `json:"agentred_fingerprint" binding:"max=128"`
	ProjectSyncID       string          `json:"project_sync_id"      binding:"max=128"`
	Payload             json.RawMessage `json:"payload"`
}

type PushRequest struct {
	mux.Meta `path:"/v1/sync/push" method:"POST"`
	Items    []PushItem `json:"items" binding:"required,min=1,max=500,dive"`
}

// PushItemResult 是一条上行的处置结果。Overwritten* 只在 status 为 conflict 时有值，
// Merged* 只在 R4b 的自然键合并发生时有值。
type PushItemResult struct {
	SyncID                       string `json:"sync_id"`
	Kind                         string `json:"kind"`
	Version                      int64  `json:"version"`
	Status                       string `json:"status"`
	Reason                       string `json:"reason,omitempty"`
	OverwrittenVersion           int64  `json:"overwritten_version,omitempty"`
	OverwrittenOriginFingerprint string `json:"overwritten_origin_fingerprint,omitempty"`
	// OverwrittenPayload 是被这次上行覆盖掉的那一版正文。上行端手上那份是覆盖
	// 别人的那一份，被覆盖的内容只有 server 有——R5 的「追回被覆盖的那一版」
	// 靠它。
	OverwrittenPayload json.RawMessage `json:"overwritten_payload,omitempty"`
	MergedSyncID       string          `json:"merged_sync_id,omitempty"`
	MergedVersion      int64           `json:"merged_version,omitempty"`
	// MergedOriginFingerprint 是落败那一份来自哪台机器（决策 14）；空串 = 服务端直写。
	MergedOriginFingerprint string `json:"merged_origin_fingerprint,omitempty"`
}

type PushResponse struct {
	Results []PushItemResult `json:"results"`
}

type PullRequest struct {
	mux.Meta `path:"/v1/sync/pull" method:"GET"`
	// Cursor 是本端已经消费到的同步版本号；0 = 拉全量。
	Cursor int64 `form:"cursor" binding:"min=0"`
	Limit  int   `form:"limit"  binding:"min=0,max=1000"`
}

type PullItem struct {
	Kind                string          `json:"kind"`
	SyncID              string          `json:"sync_id"`
	ProjectSyncID       string          `json:"project_sync_id,omitempty"`
	AgentredFingerprint string          `json:"agentred_fingerprint,omitempty"`
	Payload             json.RawMessage `json:"payload"`
	Version             int64           `json:"version"`
	UpdatedAt           int64           `json:"updated_at"`
	// OriginFingerprint 是最后一次修改来自哪台机器（决策 14：跨机引用一律用指纹，
	// 数值设备主键是 server 的本地键，桌面端离线创建的行没有它）。空串 = 服务端直写。
	OriginFingerprint string `json:"origin_fingerprint"`
	// DeletedAt 非零 = 墓碑，值是删除时刻（Unix 毫秒，决策 20）。
	DeletedAt int64 `json:"deleted_at"`
}

type PullResponse struct {
	Items      []PullItem `json:"items"`
	NextCursor int64      `json:"next_cursor"`
	HasMore    bool       `json:"has_more"`
}

type LocalPathItem struct {
	ProjectSyncID string `json:"project_sync_id" binding:"required,max=128"`
	Path          string `json:"path"            binding:"max=1024"`
}

// ReportLocalPathsRequest 是整份快照：这次没带上的项目就是被删了。
type ReportLocalPathsRequest struct {
	mux.Meta `path:"/v1/sync/local-paths" method:"POST"`
	Items    []LocalPathItem `json:"items" binding:"max=2000,dive"`
}

type ReportLocalPathsResponse struct{}

type PutAvatarRequest struct {
	mux.Meta    `path:"/v1/sync/avatars" method:"POST"`
	ContentHash string `json:"content_hash" binding:"required,len=64"`
	ContentType string `json:"content_type" binding:"max=64"`
	Content     string `json:"content"      binding:"required"`
}

type PutAvatarResponse struct {
	ContentHash string `json:"content_hash"`
}

type GetAvatarRequest struct {
	mux.Meta    `path:"/v1/sync/avatars" method:"GET"`
	ContentHash string `form:"content_hash" binding:"required,len=64"`
}

type GetAvatarResponse struct {
	ContentHash string `json:"content_hash"`
	ContentType string `json:"content_type"`
	Content     string `json:"content"`
}
