package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/agentre-hub/agentre-server/internal/model/entity/device_entity"
	"github.com/agentre-hub/agentre-server/internal/pkg/code"
	"github.com/agentre-hub/agentre-server/internal/pkg/ginctx"
	"github.com/agentre-hub/agentre-server/internal/service/device_svc"
)

// RequireScope 要求个人 token 带着 scopes 里的任意一个；其余调用方（浏览器会话、各类设备）
// 一律放行——它们的能力由身份形态决定，不按范围裁（规格 2026-11-25 决策 16：HTTP 接口的
// 范围由 server 检查，且只裁个人 token）。
//
// 缺范围时 403，正文里的文案逐字是 "token lacks scope <范围>"（多个可选范围时点名第一个），
// 同时写进 msg（本仓信封）与 error（ctl 接口的 {"error": …} 形状），两类调用方各读各的。
// 必须挂在鉴权中间件之后：它读的是鉴权放进上下文的身份。
func RequireScope(scopes ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if ginctx.DeviceKind(c) != device_svc.KindPersonalToken {
			c.Next()
			return
		}
		granted := ginctx.Scopes(c)
		for _, want := range scopes {
			for _, have := range granted {
				if have == want {
					c.Next()
					return
				}
			}
		}
		abortLackingScope(c, scopes[0])
	}
}

// DenyCLIAndTokens 拒绝 cli 设备与个人 token：它们是账号下的调用方，不是执行机，不能拿
// 提供方明文密钥（/v1/engine/snapshot），也不参与工作区同步（/v1/sync/*）。判定在路由组
// 上、先于请求体绑定，所以一份坏正文也只会得到 403。
func DenyCLIAndTokens() gin.HandlerFunc {
	return func(c *gin.Context) {
		switch ginctx.DeviceKind(c) {
		case device_entity.KindCLI, device_svc.KindPersonalToken:
			abortForbidden(c)
		default:
			c.Next()
		}
	}
}

func abortLackingScope(c *gin.Context, scope string) {
	msg := "token lacks scope " + scope
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": code.Forbidden, "msg": msg, "data": nil, "error": msg})
}
