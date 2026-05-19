package middleware

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"

	"agentre-hub/internal/pkg/code"
	"agentre-hub/internal/pkg/jwt"
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
		if isBlacklisted(c.Request.Context(), claims.JTI) {
			abortJWT(c, code.JWTBlacklisted, http.StatusUnauthorized)
			return
		}
		c.Set("user_id", claims.UID)
		c.Set("device_id", claims.DID)
		c.Set("device_kind", claims.Kind)
		c.Next()
	}
}

// Blacklist 把 jti 写入 redis，TTL = 当前 access token 剩余秒数。
func Blacklist(ctx context.Context, jti string, ttlSec int) error {
	if jti == "" {
		return errors.New("empty jti")
	}
	return redis.Default().Set(ctx, "jwt_blacklist:"+jti, "1", durationFromSec(ttlSec)).Err()
}

func isBlacklisted(ctx context.Context, jti string) bool {
	err := redis.Default().Get(ctx, "jwt_blacklist:"+jti).Err()
	if errors.Is(err, goredis.Nil) {
		return false
	}
	if err != nil {
		return false // fail-open（spec §6.5）
	}
	return true
}

func abortJWT(c *gin.Context, biz int, status int) {
	c.AbortWithStatusJSON(status, gin.H{
		"code": biz, "msg": i18n.T(c.Request.Context(), biz), "data": nil,
	})
}

func durationFromSec(n int) time.Duration { return time.Duration(n) * time.Second }
