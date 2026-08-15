package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"

	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwtblacklist"
	"agentre-server/internal/service/auth_svc"
)

// SessionOrDeviceAuth accepts either a device-JWT Bearer token (preferred) or a
// browser session cookie. On success it sets user_id, and additionally device_id
// + device_kind when the caller is a device, or csrf_token when the caller is
// a session. A session caller using an unsafe method must also clear CSRF —
// the Bearer branch carries no cookie and is exempt.
func SessionOrDeviceAuth(signer *jwt.Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if strings.HasPrefix(h, "Bearer ") {
			claims, err := signer.Verify(strings.TrimPrefix(h, "Bearer "))
			if err != nil || claims.Kind == "relay_client" || claims.DID == 0 {
				abortUnauthorized(c)
				return
			}
			if jwtblacklist.Has(c.Request.Context(), claims.JTI) {
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
		// 这一分支是凭 cookie 鉴权的，写操作必须和纯浏览器 session 组
		// （router.go 的 SessionAuth()+CSRF()）走同一条 CSRF 判据；上面的 Bearer
		// 分支已 return，结构上不受 CSRF 威胁，也就不需要出示该头。
		if !csrfOK(c, sess.CSRFToken) {
			abortForbidden(c)
			return
		}
		c.Next()
	}
}
