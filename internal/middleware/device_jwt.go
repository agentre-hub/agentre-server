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
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			abortJWT(c, code.Unauthorized, http.StatusUnauthorized)
			return
		}
		tok := strings.TrimPrefix(h, "Bearer ")
		claims, err := signer.Verify(tok)
		if err != nil {
			abortJWT(c, code.JWTSignatureInvalid, http.StatusUnauthorized)
			return
		}
		if jwtblacklist.Has(c.Request.Context(), claims.JTI) {
			abortJWT(c, code.JWTBlacklisted, http.StatusUnauthorized)
			return
		}
		c.Set("user_id", claims.UID)
		c.Set("device_id", claims.DID)
		c.Set("device_kind", claims.Kind)
		c.Next()
	}
}

func abortJWT(c *gin.Context, biz int, status int) {
	c.AbortWithStatusJSON(status, gin.H{
		"code": biz, "msg": i18n.T(c.Request.Context(), biz), "data": nil,
	})
}
