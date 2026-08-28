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

// UsableBy 判定这台设备能不能被 userID 这个账号当作自己的设备使用：查得到、归他、
// 而且还没被撤销。
//
// 三个条件必须一起判。「查得到 + 归他」少了可用性，一台已撤销的设备照样能被寻址；
// 「归他」少了，就是跨账号访问。判定放在实体上而不是各调用点，是因为它曾在
// engine_ctr / relay_svc / workspace_svc 三处各写一遍，条件已经开始各自演化。
//
// 只回 bool、不回 error：三个调用点的失败出口本来就不同（中继回
// ErrDaemonForbidden，两处读端点回 DeviceNotFound），该收敛的是判据不是出口。
// 额外的条件（比如中继还要求 kind 可寻址）由调用点自己叠在后面。
func (d *Device) UsableBy(userID int64) bool {
	return d != nil && userID != 0 && d.UserID == userID && d.IsActive()
}

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
