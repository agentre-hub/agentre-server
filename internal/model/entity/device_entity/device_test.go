package device_entity

import (
	"strings"
	"testing"

	"github.com/cago-frame/cago/pkg/consts"
	"github.com/stretchr/testify/assert"
)

func TestDevice_IsActive(t *testing.T) {
	assert.True(t, (&Device{Status: consts.ACTIVE}).IsActive())
	assert.False(t, (&Device{Status: consts.DELETE}).IsActive())
	assert.False(t, (*Device)(nil).IsActive())
}

func TestDisplayName(t *testing.T) {
	// daemon 侧的规范指纹形态：sha256:<64 位 hex>（rpc.DaemonFingerprint）。
	const daemonFP = "sha256:475776c61078781c9fda7b3345d232e32d5f176a7220ce2d129c5e39ac2db3de"

	t.Run("自报了名字就用它", func(t *testing.T) {
		assert.Equal(t, "coding", DisplayName("coding", daemonFP))
	})
	t.Run("自报名字只有空白视同没报", func(t *testing.T) {
		assert.Equal(t, "475776c6", DisplayName("   ", daemonFP))
	})
	t.Run("没自报时回退到指纹缩写，且不能把 sha256: 前缀算进去", func(t *testing.T) {
		// 直接截前 8 个字符会得到 "sha256:4"——每台机器都长一样，等于没有名字。
		assert.Equal(t, "475776c6", DisplayName("", daemonFP))
	})
	t.Run("浏览器那种无前缀指纹按原样取前 8 位", func(t *testing.T) {
		assert.Equal(t, "b363ed8b", DisplayName("", "b363ed8b7fdd0175e6d08ea8"))
	})
	t.Run("指纹本身不足 8 位就整串返回", func(t *testing.T) {
		assert.Equal(t, "ab12", DisplayName("", "ab12"))
		assert.Equal(t, "", DisplayName("", ""))
	})
	t.Run("按符文截，不切碎多字节指纹", func(t *testing.T) {
		// 端点只按 binding `min=8` 收，而 validator 数的是符文：八个多字节符文过得了
		// 校验，按字节切却会切在符文中间，落库时 MySQL 直接拒掉整条 INSERT。
		assert.Equal(t, "一二三四五六七八", DisplayName("", "一二三四五六七八九十"))
	})
}

// UsableBy 是「这台设备存在、属于这个账号、而且还能用」这一条判定。它曾在
// engine_ctr、relay_svc、workspace_svc 三处各写一遍，且已经漂了：engine_ctr 那份
// 只判归属、不判可用，一台已撤销的设备照样能拉引擎快照。判定收敛到实体上，条件
// 才不会再各自演化。
func TestUsableBy(t *testing.T) {
	active := &Device{UserID: 7, Status: consts.ACTIVE}

	assert.True(t, active.UsableBy(7))
	assert.False(t, active.UsableBy(8), "别人的设备不算")
	assert.False(t, active.UsableBy(0), "没有账号身份时一律不算")

	var missing *Device
	assert.False(t, missing.UsableBy(7), "查不到的设备不算，且不能 panic")

	revoked := &Device{UserID: 7, Status: consts.DELETE}
	assert.False(t, revoked.UsableBy(7), "已撤销的设备不算")
}

// 账号级备注名（display_name）是用户自己设的那个名字，和设备 claim 时自报的主机名
// （name）分开存：同一台 Mac 上的三个 checkout 在账号里就是三行同名设备，要撤销其中
// 一台时根本分不出该点哪个，而把用户改的名字写进 name 会被这台机器下一次 claim 原样
// 覆盖掉。
//
// NormalizeDisplayName 是收进这一列之前的唯一一道判定：去首尾空白、允许清空（清空 =
// 回落到设备自报名）、按符文判长度上限。
func TestNormalizeDisplayName(t *testing.T) {
	t.Run("去掉首尾空白", func(t *testing.T) {
		got, ok := NormalizeDisplayName("  办公室那台  ")
		assert.True(t, ok)
		assert.Equal(t, "办公室那台", got)
	})
	t.Run("只有空白等于清空", func(t *testing.T) {
		got, ok := NormalizeDisplayName("   \t\n ")
		assert.True(t, ok, "清空是合法操作，不是参数错误")
		assert.Equal(t, "", got)
	})
	t.Run("空串等于清空", func(t *testing.T) {
		got, ok := NormalizeDisplayName("")
		assert.True(t, ok)
		assert.Equal(t, "", got)
	})
	t.Run("长度按符文数判，恰好到上限仍然收", func(t *testing.T) {
		name := strings.Repeat("名", MaxDisplayNameRunes)
		got, ok := NormalizeDisplayName(name)
		assert.True(t, ok)
		assert.Equal(t, name, got)
	})
	t.Run("超过上限不收", func(t *testing.T) {
		_, ok := NormalizeDisplayName(strings.Repeat("名", MaxDisplayNameRunes+1))
		assert.False(t, ok)
	})
	t.Run("上限判的是去掉空白之后的长度", func(t *testing.T) {
		// 首尾空白不占额度：用户在输入框里多敲一个空格不该变成「太长了」。
		got, ok := NormalizeDisplayName("  " + strings.Repeat("名", MaxDisplayNameRunes) + "  ")
		assert.True(t, ok)
		assert.Equal(t, strings.Repeat("名", MaxDisplayNameRunes), got)
	})
}

// EffectiveName 是「这一行到底叫什么」的唯一判据：用户设过备注名就用它，没设就回落到
// 设备自报名。两个消费端（控制台、桌面端）都按这条规则渲染。
func TestEffectiveName(t *testing.T) {
	t.Run("设过备注名就用备注名", func(t *testing.T) {
		d := &Device{Name: "wangyizhideMacBook-Pro.local", DisplayName: "办公室那台"}
		assert.Equal(t, "办公室那台", d.EffectiveName())
	})
	t.Run("没设备注名回落到自报名", func(t *testing.T) {
		d := &Device{Name: "wangyizhideMacBook-Pro.local"}
		assert.Equal(t, "wangyizhideMacBook-Pro.local", d.EffectiveName())
	})
	t.Run("两个都没有时回落到指纹缩写", func(t *testing.T) {
		d := &Device{Fingerprint: "sha256:b363ed8b7fdd0175e6d08ea8"}
		assert.Equal(t, "b363ed8b", d.EffectiveName())
	})
	t.Run("nil 设备不 panic", func(t *testing.T) {
		var missing *Device
		assert.Equal(t, "", missing.EffectiveName())
	})
}
