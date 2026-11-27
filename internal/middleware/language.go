package middleware

import (
	"strings"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"
)

// bundleLanguages 是 internal/pkg/code 注册过的语言包标签（不含 i18n.DefaultLang 那个别名）。
var bundleLanguages = []string{"en", "zh-CN"}

// Language 让错误消息按调用方点名的语言包回：Accept-Language 的首选标签确切（不分大小写）
// 是某个语言包的标签时，把它放进请求上下文，i18n.T 随之取那一份文案。
//
// 只认确切标签、不做区域回退：agrctl 的文案是英文，它的请求点名 "en"；浏览器发的是 en-US
// 这类区域标签，照旧回落到 i18n.DefaultLang，控制台看到的文案不变。
func Language() gin.HandlerFunc {
	return func(c *gin.Context) {
		if lang, ok := preferredBundle(c.GetHeader("Accept-Language")); ok {
			c.Request = c.Request.WithContext(i18n.WithLanguage(c.Request.Context(), lang))
		}
		c.Next()
	}
}

func preferredBundle(header string) (string, bool) {
	first, _, _ := strings.Cut(header, ",")
	tag, _, _ := strings.Cut(first, ";")
	tag = strings.TrimSpace(tag)
	for _, lang := range bundleLanguages {
		if strings.EqualFold(tag, lang) {
			return lang, true
		}
	}
	return "", false
}
