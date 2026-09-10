package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwtblacklist"
)

// SessionOrDeviceAuth accepts either a device-JWT Bearer token (preferred) or a
// browser session cookie. On success it sets user_id, and additionally device_id
// + device_kind + jti when the caller is a device, or csrf_token when the caller is
// a session. A session caller using an unsafe method must also clear CSRF —
// the Bearer branch carries no cookie and is exempt.
//
// 两条分支的判定都不在本文件：Bearer 分支与 DeviceJWT 共用 verifiedJWT +
// isDeviceCredential，cookie 分支与 SessionAuth 共用 sessionPrincipal。这里只
// 编排先后与本组的终止形态——业务码一律笼统的 Unauthorized，因为同时接受两种
// 凭据时说不清是哪条路走岔了。
func SessionOrDeviceAuth(signer *jwt.Signer, blacklist *jwtblacklist.Blacklist) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 出示了 Bearer 就只走 Bearer：验签或黑名单没过时不回落到 cookie，
		// 否则一枚已被拉黑的凭据只要同时带着一份有效 cookie 就还能进来。
		if strings.HasPrefix(c.GetHeader("Authorization"), "Bearer ") {
			claims, _, ok := verifiedJWT(c, signer, blacklist)
			if !ok || !isDeviceCredential(claims) {
				abortUnauthorized(c)
				return
			}
			if accountBlocked(c, claims.UID) {
				return
			}
			setJWTClaims(c, claims)
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
