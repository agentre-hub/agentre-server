// Package relayticket 记「这张浏览器票据已经换过连接了」。
//
// 住在 internal/pkg 而不是 middleware，与 jwtblacklist 同一个理由：它是一条
// Redis 支撑的、按 jti 的标记，读写方都在边缘层，放进 service 会让中间件反向
// 依赖业务层。签发与撤销那两件事仍归 auth_svc（TrackRelayTicket /
// revokeRelayTickets）；这里只有「认领」这一步。
package relayticket

import (
	"context"
	"errors"
	"time"

	"github.com/cago-frame/cago/database/redis"
)

const keyPrefix = "relay_ticket_used:"

// Consume 认领一张票，交回「这一次是不是第一次用」。
//
// 为什么要用后即焚。浏览器原生 WebSocket 设不了请求头，票只能走 query
// （relayUrl.ts → queryTokenBridge），于是它会落进 ingress access log、反代日志、
// 浏览器 history 与 Referer。短 TTL 与登出时按 sid 批量拉黑都已经有了，但那些都
// 拦不住「泄漏之后、有效期之内」这一段。一次性把这一段压到零：日志里那份是废票。
//
// 浏览器每建一条连接本来就现取一张（relayClientPool 与 accountChannel 都是每次
// 现取），所以这条限制不改变任何正常用法。原生端的设备 JWT 不走这里：它是长期
// 凭据，本来就要反复使用。
//
// **fail-closed**，与 jwtblacklist.Has 的 fail-open 刻意相反：黑名单是短有效期
// 之外的加速手段，判不出来时放行只是少拦一次早已生效的撤销；而这里是防重放本身，
// 判不出来时放行等于开一扇只在故障时打开的门。中继这条路上 Redis 本来就是硬依赖
// （在线登记、账号通道订阅都要它），fail-closed 不会额外扩大不可用面。
func Consume(ctx context.Context, jti string, ttl time.Duration) (bool, error) {
	if jti == "" {
		return false, errors.New("empty jti")
	}
	// 记号与票同寿：票过期之后这条记号就没有意义了。
	return redis.Default().SetNX(ctx, keyPrefix+jti, "1", ttl).Result()
}
