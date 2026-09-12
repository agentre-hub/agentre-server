// Package device_token_entity 维护 device refresh token 持久化条目。
package device_token_entity

import "time"

type DeviceToken struct {
	ID               int64  `gorm:"column:id;primaryKey;autoIncrement"`
	DeviceID         int64  `gorm:"column:device_id"`
	RefreshTokenHash string `gorm:"column:refresh_token_hash"`
	// AccessTokenHash 是这一行签发的 access token 明文的 sha256 十六进制。明文只出现在
	// 签发那一次响应里，server 从不保存它。
	AccessTokenHash  string  `gorm:"column:access_token_hash;default:''"`
	RefreshExpiresAt int64   `gorm:"column:refresh_expires_at;default:0"`
	RevokedAt        int64   `gorm:"column:revoked_at;default:0"`
	UserAgent        string  `gorm:"column:user_agent;default:''"`
	IP               *string `gorm:"column:ip"`
	Createtime       int64   `gorm:"column:createtime;default:0"`
}

func (*DeviceToken) TableName() string { return "device_tokens" }

func (t *DeviceToken) IsRevoked() bool { return t != nil && t.RevokedAt > 0 }
func (t *DeviceToken) IsExpired(nowMs int64) bool {
	return t != nil && t.RefreshExpiresAt > 0 && t.RefreshExpiresAt < nowMs
}

// AccessExpiresAt 交出这一行签发的 access token 失效的时刻（unix 毫秒）：签发那一刻
// （createtime）加上 AccessTTL。库里没有单独的过期列，TTL 是配置，不随行落库。
func (t *DeviceToken) AccessExpiresAt(accessTTL time.Duration) int64 {
	return t.Createtime + accessTTL.Milliseconds()
}

// AccessValidAt 判定这一行的 access token 在 nowMs 是否还在有效期内，到点即失效。
//
// revoked_at 刻意不参与：Refresh 轮换时会置位它，而轮换出的旧 access token 在过期前
// 照常可用。让一台设备名下的令牌立即失效的是设备撤销，不是这一格。
func (t *DeviceToken) AccessValidAt(nowMs int64, accessTTL time.Duration) bool {
	return t != nil && nowMs < t.AccessExpiresAt(accessTTL)
}
