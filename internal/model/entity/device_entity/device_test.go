package device_entity

import (
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
