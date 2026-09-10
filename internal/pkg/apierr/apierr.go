// Package apierr 是「在处理链中途终止，并写出本仓的错误信封」这一件事的唯一出口。
//
// 绝大多数端点的信封由 cago 的 mux 绑定层自动套上；中间件与裸 websocket handler
// 在绑定层之外终止，得自己写。这段 {code, msg, data:null} 曾在 6 处各写一遍，
// 键名写错不会有编译错误，只会让前端 api.ts 解不出 code 而把一次 401 当成成功。
//
// 注意别顺手换成 cago 的 httputils.HandleError：它写的是
// {code, msg, request_id}，没有 data——那是另一种形状，前端可见。
package apierr

import (
	"github.com/cago-frame/cago/pkg/i18n"
	"github.com/gin-gonic/gin"
)

// Abort 以 status 作为 HTTP 状态码、biz 作为业务码终止这次请求。
//
// 两者刻意分开传：同一个 401 下有 Unauthorized / JWTBlacklisted /
// JWTSignatureInvalid 等多种业务码，daemon 靠业务码区分该重签还是该重新配对。
func Abort(c *gin.Context, status int, biz int) {
	c.AbortWithStatusJSON(status, gin.H{
		"code": biz,
		"msg":  i18n.T(c.Request.Context(), biz),
		"data": nil,
	})
}
