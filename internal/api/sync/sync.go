// Package sync 定义工作区多端同步的请求与响应结构。
//
// 载荷里不出现任何桌面端的本地自增 ID：跨机引用一律是同步标识、agentred 指纹或
// provider_key，全是字符串。载荷本身还要过 sync_entity.ValidatePayload 的守卫。
package sync

import (
	"github.com/cago-frame/cago/server/mux"

	"github.com/agentre-hub/agentre/pkg/syncwire"
)

// 线上结构归共享 module github.com/agentre-hub/agentre/pkg/syncwire 所有 —— 桌面端
// 与本仓消费同一份定义,包括那两套标签:json 标签管桌面端的编码与本仓的解码,binding
// 标签管本仓的入参校验。
//
// 本包留下的是**本仓专属**的东西:带 mux.Meta 的请求/应答信封(那是路由绑定,属于
// 宿主),以及头像那一组 —— 它不在同步契约里。
//
// PushItemResult 是本包对契约里 PushResult 的历史称呼,别名保留,调用点不用改。
type (
	PushItem       = syncwire.PushItem
	PushItemResult = syncwire.PushResult
	PullItem       = syncwire.PullItem
	LocalPathItem  = syncwire.LocalPathItem
)

type PushRequest struct {
	mux.Meta `path:"/v1/sync/push" method:"POST"`
	Items    []PushItem `json:"items" binding:"required,min=1,max=500,dive"`
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

// PullResponse 是下行的一页,即契约里的 PullPage。
type PullResponse = syncwire.PullPage

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
