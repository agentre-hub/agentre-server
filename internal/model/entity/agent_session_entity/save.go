package agent_session_entity

// SessionSave 是账号里**保存的对话**这份名单的一条（R12 后端 / R14；「关注 / 取消
// 关注」这两个词已随 2026-08-18-server-session-mirror 决策 5 作废，换成保存 / 删除，
// followed_at 这一列名早于那条决策，语义以服务层为准）。
//
// 这张表只存指向：承载它的机器、发起它的那一端、会话标识与保存时间，不存标题、
// 消息或转录——那些在本包另外三张表里。名单本身因此仍然只有指针，但它**就是镜像的
// 范围**（决策 2）：名单里的每一条，其摘要与整条转录都存在 server 上；没保存过的
// 对话一个字都不落库。这条边界由 internal/api/savedsession/guard_test.go 守。
type SessionSave struct {
	ID     int64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID int64 `gorm:"column:user_id;type:bigint;not null"`
	// ConversationID 与 UserID 一起是这一条的身份键
	// （uk_agent_session_saves_identity）：一条对话在一个账号里只保存一次。
	ConversationID string `gorm:"column:conversation_id;type:char(36);not null"`
	// DeviceFingerprint 是**承载**这条对话的那台机器（对得上 devices.fingerprint），
	// 也就是镜像该去连哪一台。
	DeviceFingerprint string `gorm:"column:device_fingerprint;type:varchar(255);not null"`
	// PeerFingerprint 是**发起**这条对话的那一端。它已退出身份键
	// （2026-08-31-conversation-centric-addressing.md「会话身份」），留作来源标注。
	//
	// 恒有值，不用空串表示「就是这台机器自己」：在本机 daemon 上开的对话（桌面端）
	// 这一列就等于 DeviceFingerprint，写进去而不是留空，按身份查才写得成一条等值
	// 条件。web 控制台派发出去的那些两者不同——发起端是浏览器，承载它的是 agentred
	// 那台机器。
	PeerFingerprint string `gorm:"column:peer_fingerprint;type:varchar(255);not null"`
	PeerSessionID   string `gorm:"column:peer_session_id;type:varchar(255);not null"`
	FollowedAt      int64  `gorm:"column:followed_at;type:bigint;not null;default:0"`
	Createtime      int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime      int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*SessionSave) TableName() string { return "agent_session_saves" }
