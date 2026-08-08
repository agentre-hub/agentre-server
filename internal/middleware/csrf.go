package middleware

import (
	"net/http"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	"agentre-server/internal/pkg/code"
)

// csrfOK 判定一次请求是否清过 CSRF：安全方法直接放行，写方法必须出示与会话
// 匹配的 X-CSRF-Token。CSRF() 与 SessionOrDeviceAuth 的 session 分支共用它，
// 保证「凭 cookie 鉴权的写操作」在两处是同一条判据。
func csrfOK(c *gin.Context, expected string) bool {
	switch c.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	if expected == "" {
		return false
	}
	got := c.GetHeader("X-CSRF-Token")
	return got != "" && got == expected
}

func CSRF() gin.HandlerFunc {
	return func(c *gin.Context) {
		expected, _ := c.Get("csrf_token")
		exp, _ := expected.(string)
		if !csrfOK(c, exp) {
			abortForbidden(c)
			return
		}
		c.Next()
	}
}

func abortForbidden(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
		"code": code.Forbidden,
		"msg":  i18n.T(c.Request.Context(), code.Forbidden),
		"data": nil,
	})
}
