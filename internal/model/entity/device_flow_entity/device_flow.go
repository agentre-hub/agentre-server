// Package device_flow_entity 维护 RFC 8628 device flow 状态机。
package device_flow_entity

type DeviceFlowCode struct {
	DeviceCode        string `gorm:"column:device_code;type:text;primaryKey"`
	UserCode          string `gorm:"column:user_code;type:text;not null"`
	DeviceKind        string `gorm:"column:device_kind;type:text;not null"`
	ClientFingerprint string `gorm:"column:client_fingerprint;type:text;not null"`
	Platform          string `gorm:"column:platform;type:text;not null;default:''"`
	Version           string `gorm:"column:version;type:text;not null;default:''"`
	AuthorizedUserID  int64  `gorm:"column:authorized_user_id;type:bigint;not null;default:0"`
	ApprovedAt        int64  `gorm:"column:approved_at;type:bigint;not null;default:0"`
	ConsumedAt        int64  `gorm:"column:consumed_at;type:bigint;not null;default:0"`
	DeniedAt          int64  `gorm:"column:denied_at;type:bigint;not null;default:0"`
	IntervalSeconds   int    `gorm:"column:interval_seconds;type:smallint;not null;default:5"`
	LastPolledAt      int64  `gorm:"column:last_polled_at;type:bigint;not null;default:0"`
	ExpiresAt         int64  `gorm:"column:expires_at;type:bigint;not null;default:0"`
	Createtime        int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
}

func (*DeviceFlowCode) TableName() string { return "device_flow_codes" }

func (c *DeviceFlowCode) IsAuthorized() bool {
	return c != nil && c.AuthorizedUserID > 0 && c.ApprovedAt > 0
}
func (c *DeviceFlowCode) IsConsumed() bool { return c != nil && c.ConsumedAt > 0 }
func (c *DeviceFlowCode) IsDenied() bool   { return c != nil && c.DeniedAt > 0 }
func (c *DeviceFlowCode) IsExpired(nowMs int64) bool {
	return c != nil && c.ExpiresAt > 0 && c.ExpiresAt < nowMs
}
func (c *DeviceFlowCode) IsPending() bool {
	return c != nil && !c.IsAuthorized() && !c.IsDenied() && !c.IsConsumed()
}

// NextPollAllowed 返回 nowMs 是否满足 interval 间隔（ms）。
func (c *DeviceFlowCode) NextPollAllowed(nowMs int64) bool {
	if c == nil {
		return false
	}
	minGap := int64(c.IntervalSeconds) * 1000
	return nowMs-c.LastPolledAt >= minGap
}
