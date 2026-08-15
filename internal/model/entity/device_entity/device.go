// Package device_entity 维护设备实体。
package device_entity

import (
	"strings"

	"github.com/cago-frame/cago/pkg/consts"
)

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

// fingerprintPrefix 是 daemon 侧规范指纹的算法前缀（sha256:<64 位 hex>）。
const fingerprintPrefix = "sha256:"

// displayNameFallbackRunes 是回退名取的指纹符文数。
const displayNameFallbackRunes = 8

// DisplayName 返回设备列表里显示的名字：客户端自报的名字优先，缺省时回退到指纹缩写。
//
// 回退**先剥掉 sha256: 前缀再截**：daemon 与桌面端的规范指纹都是 sha256:<64 位 hex>，
// 直接截前 8 个字符拿到的是 "sha256:" 加一个十六进制字符 —— 整个账号下的机器最多只有
// 16 种名字，等于没有名字。
//
// 按符文而不是按字节截：指纹由客户端自己生成，端点只按 binding `min=8` 收，而 validator
// 的 min 数的正是符文 —— 八个多字节符文的指纹过得了校验，按字节切却会切在符文中间，
// 落库的是一段非法 UTF-8，数据库会拒掉整条 INSERT。
func DisplayName(reported, fingerprint string) string {
	if name := strings.TrimSpace(reported); name != "" {
		return name
	}
	runes := []rune(strings.TrimPrefix(fingerprint, fingerprintPrefix))
	if len(runes) <= displayNameFallbackRunes {
		return string(runes)
	}
	return string(runes[:displayNameFallbackRunes])
}
