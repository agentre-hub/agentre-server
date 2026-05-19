package middleware

import (
	"net/http"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	"agentre-hub/internal/pkg/code"
)

func CSRF() gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}
		expected, _ := c.Get("csrf_token")
		exp, _ := expected.(string)
		if exp == "" {
			abortForbidden(c)
			return
		}
		got := c.GetHeader("X-CSRF-Token")
		if got == "" || got != exp {
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
