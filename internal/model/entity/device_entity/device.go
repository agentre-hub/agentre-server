// Package device_entity 维护设备实体。
package device_entity

import "github.com/cago-frame/cago/pkg/consts"

const (
	KindDesktop  = "desktop"
	KindAgentred = "agentred"
	KindWeb      = "web"
	KindMobile   = "mobile"
)

type Device struct {
	ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID      int64  `gorm:"column:user_id;type:bigint;not null"`
	Name        string `gorm:"column:name;type:text;not null"`
	Kind        string `gorm:"column:kind;type:text;not null"`
	Platform    string `gorm:"column:platform;type:text;not null;default:''"`
	Version     string `gorm:"column:version;type:text;not null;default:''"`
	Fingerprint string `gorm:"column:fingerprint;type:text;not null"`
	LastSeenAt  int64  `gorm:"column:last_seen_at;type:bigint;not null;default:0"`
	Status      int    `gorm:"column:status;type:smallint;not null;default:1"`
	Createtime  int64  `gorm:"column:createtime;type:bigint;not null;default:0"`
	Updatetime  int64  `gorm:"column:updatetime;type:bigint;not null;default:0"`
}

func (*Device) TableName() string { return "devices" }

func (d *Device) IsActive() bool { return d != nil && d.Status == consts.ACTIVE }
