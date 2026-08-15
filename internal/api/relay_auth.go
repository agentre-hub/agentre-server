package api

import (
	"github.com/gin-gonic/gin"
)

// queryTokenBridge 把 query 里的 access_token 搬到 Authorization 头,让浏览器原生
// WebSocket(无法设置自定义请求头)也能携带短效 relay ticket 连
// /v1/relay/client。随后由 RelayClientJWT 同时校验 relay ticket 和原生端的
// Device JWT；Authorization 头在场时以头为准，query 不覆盖。
func queryTokenBridge() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			if tok := c.Query("access_token"); tok != "" {
				c.Request.Header.Set("Authorization", "Bearer "+tok)
			}
		}
		c.Next()
	}
}
