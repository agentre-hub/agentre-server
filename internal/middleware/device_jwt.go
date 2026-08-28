package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/pkg/apierr"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/jwt"
)

func DeviceJWT(signer *jwt.Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, biz, ok := verifiedJWT(c, signer)
		if !ok {
			apierr.Abort(c, http.StatusUnauthorized, biz)
			return
		}
		if !isDeviceCredential(claims) {
			apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
			return
		}
		if accountBlocked(c, claims.UID) {
			return
		}
		setJWTClaims(c, claims)
		c.Next()
	}
}

// RelayClientJWT accepts ordinary device JWTs for native clients and the browser's
// short-lived relay_client ticket. The latter is deliberately rejected by DeviceJWT.
func RelayClientJWT(signer *jwt.Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, biz, ok := verifiedJWT(c, signer)
		if !ok {
			apierr.Abort(c, http.StatusUnauthorized, biz)
			return
		}
		if !isRelayClientCredential(claims) {
			apierr.Abort(c, http.StatusUnauthorized, code.Unauthorized)
			return
		}
		if accountBlocked(c, claims.UID) {
			return
		}
		setJWTClaims(c, claims)
		c.Next()
	}
}
