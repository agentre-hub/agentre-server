// Package follow 定义账号级关注名单的端点（R12 后端 / R14）。
//
// 名单属于账号，不属于某一台设备或某一个浏览器；payload 只含目标设备指纹、
// 会话标识、关注时间与失效标记，不含标题、消息或转录——字段白名单由
// guard_test.go 锁住，这是硬不变量（server 不持有任何会话内容）的唯一例外的边界。
package follow

import "github.com/cago-frame/cago/server/mux"

// ---------- 关注 ----------

// FollowRequest 关注一条会话（R12）。账号取自鉴权上下文（会话 / 设备 JWT），
// 不由请求体提供。重复关注幂等。
type FollowRequest struct {
	mux.Meta `path:"/v1/follows" method:"POST"`
	// DeviceFingerprint 是目标会话所在 agentred 的设备指纹。
	DeviceFingerprint string `json:"device_fingerprint" binding:"required,min=8,max=128"`
	// SessionID 是发起端本地自增的会话标识。服务端只把它当作不透明指针落库，
	// 不解析、也不知道它指哪条会话。
	SessionID string `json:"session_id" binding:"required,min=1,max=256"`
}

type FollowResponse struct{}

// ---------- 取消关注 ----------

// UnfollowRequest 取消关注（R12）。幂等；只去掉这一条，不触碰别的关注。
type UnfollowRequest struct {
	mux.Meta `path:"/v1/follows/unfollow" method:"POST"`
	// DeviceFingerprint 与 SessionID 必须与关注时一致。
	DeviceFingerprint string `json:"device_fingerprint" binding:"required,min=8,max=128"`
	SessionID         string `json:"session_id" binding:"required,min=1,max=256"`
}

type UnfollowResponse struct{}

// ---------- 名单 ----------

type ListFollowsRequest struct {
	mux.Meta `path:"/v1/follows" method:"GET"`
}

// FollowItem 是名单里的一条。字段白名单由 guard_test.go 锁住。
type FollowItem struct {
	DeviceFingerprint string `json:"device_fingerprint"`
	SessionID         string `json:"session_id"`
	FollowedAt        int64  `json:"followed_at"`
	// Invalid 目标设备已不在账号活跃设备里（被撤销 / 不存在）时为 true：名单内容
	// 不变（R14），只是这一条已无对可指，客户端可据此移除。
	Invalid bool `json:"invalid"`
}

type ListFollowsResponse struct {
	Items []FollowItem `json:"items"`
}
