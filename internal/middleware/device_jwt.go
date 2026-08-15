package middleware

import (
	"net/http"
	"strings"

	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	"agentre-server/internal/pkg/code"
	"agentre-server/internal/pkg/jwt"
	"agentre-server/internal/pkg/jwtblacklist"
)

func DeviceJWT(signer *jwt.Signer) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, ok := verifiedJWT(c, signer)
		if !ok {
			return
		}
		if claims.Kind == "relay_client" || claims.DID == 0 {
			abortJWT(c, code.Unauthorized, http.StatusUnauthorized)
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
		claims, ok := verifiedJWT(c, signer)
		if !ok {
			return
		}
		if claims.Kind == "relay_client" {
			if claims.DID != 0 {
				abortJWT(c, code.Unauthorized, http.StatusUnauthorized)
				return
			}
		} else if claims.DID == 0 {
			abortJWT(c, code.Unauthorized, http.StatusUnauthorized)
			return
		}
		setJWTClaims(c, claims)
		c.Next()
	}
}

func verifiedJWT(c *gin.Context, signer *jwt.Signer) (*jwt.Claims, bool) {
	h := c.GetHeader("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		abortJWT(c, code.Unauthorized, http.StatusUnauthorized)
		return nil, false
	}
	claims, err := signer.Verify(strings.TrimPrefix(h, "Bearer "))
	if err != nil {
		abortJWT(c, code.JWTSignatureInvalid, http.StatusUnauthorized)
		return nil, false
	}
	if jwtblacklist.Has(c.Request.Context(), claims.JTI) {
		abortJWT(c, code.JWTBlacklisted, http.StatusUnauthorized)
		return nil, false
	}
	return claims, true
}

func setJWTClaims(c *gin.Context, claims *jwt.Claims) {
	c.Set("user_id", claims.UID)
	c.Set("device_id", claims.DID)
	c.Set("device_kind", claims.Kind)
}

func abortJWT(c *gin.Context, biz int, status int) {
	c.AbortWithStatusJSON(status, gin.H{
		"code": biz, "msg": i18n.T(c.Request.Context(), biz), "data": nil,
	})
}
