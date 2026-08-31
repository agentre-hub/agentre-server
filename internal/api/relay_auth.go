package api

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// bearerSubprotocolPrefix 是浏览器用来携带票据的**伪子协议**前缀。
//
// 浏览器原生 WebSocket 设不了请求头，但子协议列表是能设的（`new WebSocket(url,
// protocols)` 的第二个参数），而它走的是 Sec-WebSocket-Protocol 请求头 —— 不进 URL，
// 因此不进 ingress access log、反代日志、浏览器 history 与 Referer。
//
// 它只是载体，不参与协商：服务端的 upgrader 只声明 agentre-protobuf，回选时不会
// 选中它（见 relayws.ProtobufSubprotocol）。
const bearerSubprotocolPrefix = "agentre.bearer."

// relayTokenBridge 把浏览器带来的票搬进 Authorization 头，让后面的鉴权中间件
// 不必知道它是怎么来的。
//
// 两条来路，优先级有讲究：
//
//   - **子协议**（首选）。票不进 URL，泄漏面小得多。
//   - **query**（退路）。滚动更新期间新前端会连到旧副本、旧前端会连到新副本，
//     两个方向都得通，所以这条要留。它是过渡期的形状，等前端全量走子协议之后
//     就该删掉 —— 那时这个函数只剩上面一条分支。
//
// 两者都在时以子协议为准：它才是不进日志的那一条。
func relayTokenBridge() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			if token := bearerFromSubprotocols(c.GetHeader("Sec-WebSocket-Protocol")); token != "" {
				c.Request.Header.Set("Authorization", "Bearer "+token)
			} else if token := c.Query("access_token"); token != "" {
				c.Request.Header.Set("Authorization", "Bearer "+token)
			}
		}
		c.Next()
	}
}

// bearerFromSubprotocols 从提议的子协议列表里取出票。列表是逗号分隔、可带空格的
// token 序列（RFC 6455 §11.3.4）。
func bearerFromSubprotocols(header string) string {
	for _, offered := range strings.Split(header, ",") {
		offered = strings.TrimSpace(offered)
		if token, ok := strings.CutPrefix(offered, bearerSubprotocolPrefix); ok && token != "" {
			return token
		}
	}
	return ""
}
