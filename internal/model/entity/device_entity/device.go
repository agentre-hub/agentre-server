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
	ID     int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID int64  `gorm:"column:user_id"`
	Name   string `gorm:"column:name"`
	// DisplayName 是**用户**给这台设备起的账号级备注名，空串 = 没起过。
	//
	// 它不能与 Name 共用一列：Name 是设备 claim 时自报的主机名，那台机器每次重新配对
	// 都会再报一次并覆盖掉这一格（见 Upsert 的赋值列）。同一台 Mac 上的三个 checkout
	// 在账号里就是三行同名设备，撤销其中一台时分不出该点哪个——分不出这件事只能靠一个
	// 设备自己覆盖不到的列解决。
	DisplayName string `gorm:"column:display_name;default:''"`
	Kind        string `gorm:"column:kind"`
	Platform    string `gorm:"column:platform;default:''"`
	Version     string `gorm:"column:version;default:''"`
	Fingerprint string `gorm:"column:fingerprint"`
	LastSeenAt  int64  `gorm:"column:last_seen_at;default:0"`
	Status      int    `gorm:"column:status;default:1"`
	Createtime  int64  `gorm:"column:createtime;default:0"`
	Updatetime  int64  `gorm:"column:updatetime;default:0"`
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

// MaxDisplayNameRunes 是账号级备注名的长度上限，按**符文**数。
//
// 取 128 与设备自报名同一个数（api/device.DeviceAuthorizeRequest.Name 的
// binding `max=128`）：两者进的是同一个显示位，一个能放下另一个就该放得下。列本身是
// varchar(255)，符文上限因此永远先于列宽生效，不会出现「校验过了、落库被截断」。
const MaxDisplayNameRunes = 128

// NormalizeDisplayName 把用户输入的备注名规范成可落库的形态，并判定它收不收。
//
// 去首尾空白，清空合法（空串 = 回落到设备自报名），长度按符文数判——与 DisplayName
// 的回退同一个理由：按字节判会让一个合法的中文名字莫名其妙地「太长」。
//
// 判定放在实体上而不是 controller 的 binding tag 上：binding 数的是**修剪前**的长度，
// 于是「恰好到上限 + 首尾各一个空格」会被拒，而它修剪之后明明合法。一条规则只能有
// 一个判据。
func NormalizeDisplayName(s string) (string, bool) {
	name := strings.TrimSpace(s)
	if len([]rune(name)) > MaxDisplayNameRunes {
		return "", false
	}
	return name, true
}

// EffectiveName 是这台设备在界面上到底叫什么：用户设过备注名就用它，没设就回落到设备
// 自报名，两个都没有时回落到指纹缩写。
//
// 回落规则只写在这里一处。控制台、桌面端与将来任何一个消费端都从设备列表里拿到
// display_name 与 name 两格，按同一条规则渲染。
func (d *Device) EffectiveName() string {
	if d == nil {
		return ""
	}
	if name := strings.TrimSpace(d.DisplayName); name != "" {
		return name
	}
	return DisplayName(d.Name, d.Fingerprint)
}
