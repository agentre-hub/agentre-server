package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"

	"agentre-hub/internal/pkg/jwt"
	"agentre-hub/internal/service/auth_svc"
)

// SessionOrDeviceAuth accepts either a device-JWT Bearer token (preferred) or a
// browser session cookie. On success it sets user_id, and additionally device_id
// + device_kind when the caller is a device, or csrf_token when the caller is
// a session.
func SessionOrDeviceAuth(signer *jwt.Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if strings.HasPrefix(h, "Bearer ") {
			claims, err := signer.Verify(strings.TrimPrefix(h, "Bearer "))
			if err != nil {
				abortUnauthorized(c)
				return
			}
			if isBlacklisted(c.Request.Context(), claims.JTI) {
				abortUnauthorized(c)
				return
			}
			c.Set("user_id", claims.UID)
			c.Set("device_id", claims.DID)
			c.Set("device_kind", claims.Kind)
			c.Next()
			return
		}
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
