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
// 全小写的 "zh-cn"。middleware.Language 只在 Accept-Language 首选标签确切是某个语言包
// 时放进语言，绝大多数调用（没带头、浏览器的区域标签）都走那条回落分支。一旦语言包注册
// 在别的标签下，langs[DefaultLang] 就是 nil map，langMap[code] 取回零值，客户端拿到的
// 是 {"code":30300,"msg":""} —— 有码无文案，而且是**所有**错误码、**所有**客户端。
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

// 英文包如今会被取到（middleware.Language，agrctl 点名 en）：任一语言包里登记过的码，
// 两种语言都要有文案。只遍历中文包时，一个只写了英文的码在默认（中文）路径上取回空串
// 而不被发现；漏一个，对应那一端拿到的就是空的 msg。
func TestT_GivenEitherLanguage_ThenEveryRegisteredCodeResolvesInBoth(t *testing.T) {
	enCtx := i18n.WithLanguage(context.Background(), "en")
	codes := map[int]struct{}{}
	for c := range zhCN {
		codes[c] = struct{}{}
	}
	for c := range en {
		codes[c] = struct{}{}
	}
	for c := range codes {
		assert.NotEmptyf(t, i18n.T(enCtx, c), "code %d has no English text", c)
		assert.NotEmptyf(t, i18n.T(context.Background(), c), "code %d has no Chinese text", c)
	}
}
