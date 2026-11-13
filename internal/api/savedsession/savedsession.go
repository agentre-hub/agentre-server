// Package savedsession 定义账号里「保存的对话」这一族端点：保存、删除。
//
// 名单属于账号，不属于某一台设备或某一个浏览器。它同时是**镜像的范围**——账号里
// 保存过的对话才有内容（标题与整条转录）镜像在 server 上，没保存过的一个字都不落库
// （规格 2026-08-18-server-session-mirror 决策 2）。这条隐私边界由 guard_test.go 守。
//
// 动作不叫「关注 / 取消关注」（决策 5）：server 真的持有内容，动作不是「记一个指向」，
// 而是「把整条对话存进账号」与「把它连同执行端那一份一起清掉」，端点因此照实说这件事。
package savedsession

import "github.com/cago-frame/cago/server/mux"

// SaveSessionRequest 把一条对话收进账号，镜像随即对它开始。账号取自鉴权上下文
// （会话 / 设备 JWT），不由请求体提供。重复保存幂等。
type SaveSessionRequest struct {
	mux.Meta `path:"/v1/saved-sessions" method:"POST"`
	// DeviceFingerprint 是**承载**这条对话的那台机器（对得上 devices.fingerprint）。
	// 镜像据它决定去连谁。
	DeviceFingerprint string `json:"device_fingerprint" binding:"required,min=8,max=128"`
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
// 身份之外，机器默认不由调用方报：承载它的机器是保存时记下的，服务端按身份查得出
// 来（发起端是浏览器的对话，调用方根本报不出来）。唯一的例外是 machine_fingerprint：
// 桌面端删一条没保存过的远端对话时，账号里没有索引行可查，才由它指明执行端；
// 有索引行时忽略，且必须是本账号的设备，否则也忽略。
type DeleteSessionRequest struct {
	mux.Meta `path:"/v1/saved-sessions/delete" method:"POST"`
	// conversation_id 全局唯一，机器与发起端默认由服务端自己查出来。
	ConversationID string `json:"conversation_id" binding:"required,uuid"`
	// MachineFingerprint 可省：仅在账号里没有这条对话的索引行时，指明执行它的机器。
	MachineFingerprint string `json:"machine_fingerprint" binding:"omitempty,min=8,max=128"`
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
