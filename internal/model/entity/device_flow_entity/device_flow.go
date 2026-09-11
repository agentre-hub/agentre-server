// Package device_flow_entity 维护 RFC 8628 device flow 状态机。
package device_flow_entity

type DeviceFlowCode struct {
	ID int64 `gorm:"column:id;primaryKey;autoIncrement"`
	// DeviceCode 是自然键，落在唯一索引上；行身份由 ID 承担。
	DeviceCode        string `gorm:"column:device_code"`
	UserCode          string `gorm:"column:user_code"`
	DeviceKind        string `gorm:"column:device_kind"`
	ClientFingerprint string `gorm:"column:client_fingerprint"`
	// ClientName 是客户端自报的显示名（通常是主机名），可空；换取 token 时决定
	// devices.name，缺省则回退到指纹缩写。
	ClientName       string `gorm:"column:client_name;default:''"`
	Platform         string `gorm:"column:platform;default:''"`
	Version          string `gorm:"column:version;default:''"`
	AuthorizedUserID int64  `gorm:"column:authorized_user_id;default:0"`
	ApprovedAt       int64  `gorm:"column:approved_at;default:0"`
	ConsumedAt       int64  `gorm:"column:consumed_at;default:0"`
	DeniedAt         int64  `gorm:"column:denied_at;default:0"`
	IntervalSeconds  int    `gorm:"column:interval_seconds;default:5"`
	LastPolledAt     int64  `gorm:"column:last_polled_at;default:0"`
	ExpiresAt        int64  `gorm:"column:expires_at;default:0"`
	Createtime       int64  `gorm:"column:createtime;default:0"`
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
