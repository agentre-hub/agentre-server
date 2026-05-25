// Package device_token_entity 维护 device refresh token 持久化条目。
package device_token_entity

type DeviceToken struct {
	ID               int64   `gorm:"column:id;primaryKey;autoIncrement"`
	DeviceID         int64   `gorm:"column:device_id;type:bigint;not null"`
	RefreshTokenHash string  `gorm:"column:refresh_token_hash;type:text;not null"`
	RefreshExpiresAt int64   `gorm:"column:refresh_expires_at;type:bigint;not null;default:0"`
	LastUsedAt       int64   `gorm:"column:last_used_at;type:bigint;not null;default:0"`
	RotatedFromID    int64   `gorm:"column:rotated_from_id;type:bigint;not null;default:0"`
	RevokedAt        int64   `gorm:"column:revoked_at;type:bigint;not null;default:0"`
	UserAgent        string  `gorm:"column:user_agent;type:text;not null;default:''"`
	IP               *string `gorm:"column:ip;type:inet"`
	Createtime       int64   `gorm:"column:createtime;type:bigint;not null;default:0"`
}

func (*DeviceToken) TableName() string { return "device_tokens" }

func (t *DeviceToken) IsRevoked() bool { return t != nil && t.RevokedAt > 0 }
func (t *DeviceToken) IsExpired(nowMs int64) bool {
	return t != nil && t.RefreshExpiresAt > 0 && t.RefreshExpiresAt < nowMs
}
