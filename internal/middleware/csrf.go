package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
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
	return got == expected
}

func CSRF() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !csrfOK(c, ginctx.CSRFToken(c)) {
			abortForbidden(c)
			return
		}
		c.Next()
	}
}

func abortForbidden(c *gin.Context) {
	apierr.Abort(c, http.StatusForbidden, code.Forbidden)
}
