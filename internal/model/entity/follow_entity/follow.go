// Package follow_entity 维护账号级关注名单实体（R12 后端 / R14）。
//
// 这是 agentre-server 唯一存放「会话指向」的表：只存目标设备指纹、会话标识与
// 关注时间，不存标题、消息或转录——硬不变量（server 不持有任何会话内容）的
// 唯一例外以「不持有内容」的方式落地。字段白名单由
// internal/api/follow/guard_test.go 锁住。
package follow_entity

type FollowedSession struct {
	ID                int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID            int64  `gorm:"column:user_id;type:bigint;not null"`
	DeviceFingerprint string `gorm:"column:device_fingerprint;type:text;not null"`
	SessionID         string `gorm:"column:session_id;type:text;not null"`
	FollowedAt        int64  `gorm:"column:followed_at;type:bigint;not null;default:0"`
	Createtime        int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime        int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*FollowedSession) TableName() string { return "followed_sessions" }
