package middleware

import (
	"net/http"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	"agentre-server/internal/pkg/code"
	"agentre-server/internal/service/auth_svc"
)

func SessionAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		sid, _ := c.Cookie(auth_svc.Default().CookieName())
		if sid == "" {
			abortUnauthorized(c)
			return
		}
		sess, err := auth_svc.Default().GetSession(c.Request.Context(), sid)
		if err != nil || sess == nil {
			abortUnauthorized(c)
			return
		}
		c.Set("user_id", sess.UserID)
		c.Set("csrf_token", sess.CSRFToken)
		c.Next()
	}
}

func abortUnauthorized(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
		"code": code.Unauthorized,
		"msg":  i18n.T(c.Request.Context(), code.Unauthorized),
		"data": nil,
	})
}
