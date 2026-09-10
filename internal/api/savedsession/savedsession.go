// Package follow 定义账号里「保存的对话」这一族端点：保存、删除，以及读出这份名单。
//
// 名单属于账号，不属于某一台设备或某一个浏览器。它同时是**镜像的范围**——账号里
// 保存过的对话才有内容（标题与整条转录）镜像在 server 上，没保存过的一个字都不落库
// （规格 2026-08-18-server-session-mirror 决策 2）。这条隐私边界由 guard_test.go 守。
//
// 「关注 / 取消关注」这两个词已经作废（决策 5）：一旦 server 真的持有内容，动作就不再
// 是「记一个指向」，而是「把整条对话存进账号」与「把它连同执行端那一份一起清掉」，
// 端点因此照实说这件事。
package savedsession

import "github.com/cago-frame/cago/server/mux"

// SaveSessionRequest 把一条对话收进账号，镜像随即对它开始。账号取自鉴权上下文
// （会话 / 设备 JWT），不由请求体提供。重复保存幂等。
type SaveSessionRequest struct {
	mux.Meta `path:"/v1/saved-sessions" method:"POST"`
	// MachineFingerprint 是**承载**这条对话的那台机器（对得上 devices.fingerprint）。
	// 镜像据它决定去连谁。
	MachineFingerprint string `json:"machine_fingerprint" binding:"required,min=8,max=128"`
	// PeerFingerprint 是**发起**这条对话那一端的指纹。它已经不是身份的一半
	// （2026-08-31-conversation-centric-addressing.md「会话身份」），落库只作来源
	// 标注与授权。
	//
	// 可以留空，意为「就是这台机器自己」——在本机 daemon 上开的对话（桌面端）不带
	// origin，执行端报回来的也是空。
	PeerFingerprint string `json:"peer_fingerprint" binding:"omitempty,min=8,max=128"`
	// ConversationID 是这条对话的身份：发起端建档那一刻铸的 UUIDv7（存量对话是
	// 按决策 2 派生的 UUIDv5）。名单、摘要、转录、待办四张表都照它存。
	ConversationID string `json:"conversation_id" binding:"required,uuid"`
}

type SaveSessionResponse struct{}

// DeleteSessionRequest 删掉账号里的这条对话，**连同执行端上那一份**（决策 6）。
// 幂等；只删这一条，不触碰别的。
//
// 只要身份，不要机器：承载它的机器是保存时记下的，服务端按身份查得出来。让调用方
// 报的话，发起端是浏览器的那些对话（web 控制台派发出去的）根本报不出来——索引行上
// 只有身份，没有机器。
type DeleteSessionRequest struct {
	mux.Meta `path:"/v1/saved-sessions/delete" method:"POST"`
	// 只要身份：conversation_id 全局唯一，机器与发起端都由服务端自己查出来。
	ConversationID string `json:"conversation_id" binding:"required,uuid"`
}

// DeleteSessionResponse 交代**执行端那一份**的去向；应答返回时 server 那一份一定
// 已经没了（机器离线也照样当场删掉，界面上不留「已删除但还在」的中间态）。
type DeleteSessionResponse struct {
	// MachineStatus 取两个值（saved_session_svc.MachineDeleteOutcome 的全集）：
	//   deleted — 那台机器在线，它那一份也已经删了；
	//   pending — 联系不上那台机器，已记下待办，它下次上线时补删。
	//
	// 执行端不认识删除方法**不在这里出档**：那是协议违约（ErrMachineProtocolViolation），
	// 以错误上交，不折成一个正常应答里的状态值。
	MachineStatus string `json:"machine_status"`
}

// ListSavedSessionsRequest 读出账号里已保存的对话。路径与载荷本轮不动：索引改读镜像摘要
// 那一轮会用带内容的摘要端点接手它。
type ListSavedSessionsRequest struct {
	mux.Meta `path:"/v1/follows" method:"GET"`
}

// SavedSessionRef 是名单里的一条：只有指向与时间。
type SavedSessionRef struct {
	DeviceFingerprint string `json:"device_fingerprint"`
	ConversationID    string `json:"conversation_id"`
	FollowedAt        int64  `json:"followed_at"`
	// Invalid 目标设备已不在账号活跃设备里（被撤销 / 不存在）时为 true：名单内容
	// 不变（R14），只是这一条已无对可指，客户端可据此移除。
	Invalid bool `json:"invalid"`
}

type ListSavedSessionsResponse struct {
	Items []SavedSessionRef `json:"items"`
}
