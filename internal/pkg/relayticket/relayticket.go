// Package relayticket 记录浏览器中继票据是否已经被使用。
// 签发与撤销由 auth_svc 负责，本包只提供边缘层的 Redis 认领操作。
package relayticket

import (
	"context"
	"errors"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

const keyPrefix = "relay_ticket_used:"

// Tickets 是一份焚毁记号，用构造时交给它的那台 Redis（理由同
// jwtblacklist.Blacklist：「记号存在哪」只该由组合根回答一次）。
type Tickets struct {
	redis *goredis.Client
}

func New(rc *goredis.Client) *Tickets { return &Tickets{redis: rc} }

// Consume 认领一张票，交回「这一次是不是第一次用」。
//
// 票据通过 query 传输，必须一次性消费以降低日志或历史记录泄漏后的重放风险。
// Redis 不可用时拒绝消费（fail-closed）；设备 JWT 不经过此包。
func (t *Tickets) Consume(ctx context.Context, jti string, ttl time.Duration) (bool, error) {
	if jti == "" {
		return false, errors.New("empty jti")
	}
	// 记号与票同寿：票过期之后这条记号就没有意义了。
	return t.redis.SetNX(ctx, keyPrefix+jti, "1", ttl).Result()
}
