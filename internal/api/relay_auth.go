package api

import (
	"github.com/gin-gonic/gin"
)

// queryTokenBridge 把 query 里的 access_token 搬到 Authorization 头,让浏览器原生
// WebSocket(无法设置自定义请求头)也能携带设备 JWT 连 /v1/relay/client。随后的
// DeviceJWT 中间件原样复用(校验 + 黑名单),不引入第二套鉴权;Authorization 头在场
// 时以头为准,query 不覆盖。
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
