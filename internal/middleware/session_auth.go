package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
)

func SessionAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		sess, ok := sessionPrincipal(c)
		if !ok {
			abortUnauthorized(c)
			return
		}
		if accountBlocked(c, sess.UserID) {
			return
		}
		setSessionPrincipal(c, sess)
		c.Next()
	}
}

func abortUnauthorized(c *gin.Context) {
	apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
}
