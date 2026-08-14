package code

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/stretchr/testify/assert"
)

// 错误码必须解析得出文案。
//
// 这里守的是**注册标签与解析标签必须对得上**这件事，而不是「文案写全了没」：
// cago 的 i18n.T 在 ctx 里没有语言时回落到 i18n.DefaultLang，而 DefaultLang 是
// 全小写的 "zh-cn"。本仓库没有任何设置语言的中间件（grep WithLanguage 无命中），
// 所以每一次调用都走那条回落分支。一旦语言包注册在别的标签下，langs[DefaultLang]
// 就是 nil map，langMap[code] 取回零值，客户端拿到的是 {"code":30300,"msg":""} ——
// 有码无文案，而且是**所有**错误码、**所有**客户端。
func TestT_GivenNoLanguageInContext_ThenEveryRegisteredCodeResolves(t *testing.T) {
	ctx := context.Background()

	// 全量遍历：漏一个标签就会让整批文案一起消失，抽查看不出来。
	for c, want := range zhCN {
		got := i18n.T(ctx, c)
		assert.NotEmptyf(t, got,
			"code %d 解析不出文案（应为 %q）——语言包注册的标签与 i18n.DefaultLang(%q) 对不上",
			c, want, i18n.DefaultLang)
	}
}

// 显式带上语言时按该语言解析，中英各自成立。
func TestT_GivenExplicitLanguage_ThenResolvesInThatLanguage(t *testing.T) {
	assert.Equal(t, zhCN[DeviceNotFound],
		i18n.T(i18n.WithLanguage(context.Background(), "zh-CN"), DeviceNotFound))
	assert.Equal(t, en[DeviceNotFound],
		i18n.T(i18n.WithLanguage(context.Background(), "en"), DeviceNotFound))
}
