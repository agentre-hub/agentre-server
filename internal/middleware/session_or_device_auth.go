package middleware

import (
	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
)

// SessionOrDeviceAuth accepts either a device access token Bearer (preferred) or a
// browser session cookie. On success it sets user_id, and additionally device_id
// + device_kind + credential_handle when the caller is a device, or csrf_token when
// the caller is a session. A session caller using an unsafe method must also clear
// CSRF — the Bearer branch carries no cookie and is exempt.
//
// 两条分支的判定都不在本文件：Bearer 分支与 DeviceJWT 共用 devicePrincipal，cookie 分支
// 与 SessionAuth 共用 sessionPrincipal。这里只编排先后与本组的终止形态。
func SessionOrDeviceAuth(tokens BearerResolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 出示了 Bearer 就只走 Bearer：令牌不认时不回落到 cookie，否则一枚已失效的凭据
		// 只要同时带着一份有效 cookie 就还能进来。
		if token, presented := bearerToken(c); presented {
			p, status, businessCode, ok := devicePrincipal(c, tokens, token)
			if !ok {
				apierr.Abort(c, status, businessCode)
				return
			}
			if accountBlocked(c, p.AccountID) {
				return
			}
			setBearerPrincipal(c, p)
			c.Next()
			return
		}
		sess, ok := sessionPrincipal(c)
		if !ok {
			abortUnauthorized(c)
			return
		}
		if accountBlocked(c, sess.UserID) {
			return
		}
		setSessionPrincipal(c, sess)
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
