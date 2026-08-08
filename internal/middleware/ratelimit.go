package middleware

import (
	"net/http"
	"time"

	"github.com/cago-frame/cago/database/redis"
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"

	"agentre-server/internal/pkg/code"
	"agentre-server/internal/pkg/ratelimit"
)

// AuthorizePerIPLimit：每 IP 每分钟最多 N 次。
func AuthorizePerIPLimit(limit int64) gin.HandlerFunc {
	l := ratelimit.New(redis.Default(), "rl:authz:", limit, time.Minute)
	return func(c *gin.Context) {
		ok, err := l.Allow(c.Request.Context(), c.ClientIP())
		if err != nil {
			c.Next()
			return
		}
		if !ok {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"code": code.OperationFailed,
				"msg":  i18n.T(c.Request.Context(), code.OperationFailed),
				"data": nil,
			})
			return
		}
		c.Next()
	}
}
