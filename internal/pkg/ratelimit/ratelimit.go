// Package ratelimit 在 Redis 上实现简单的 INCR + EXPIRE 计数限流。
//
// 不用 Lua（miniredis 不支持复杂 EVAL）；用 INCR 后看返回值是否 == 1
// 决定是否要 EXPIRE。允许一个时间窗内允许 N 次。
package ratelimit

import (
	"context"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

type Limiter struct {
	rc     *goredis.Client
	prefix string
	limit  int64
	window time.Duration
}

// New 构造 limiter。window 内最多允许 limit 次。
func New(rc *goredis.Client, prefix string, limit int64, window time.Duration) *Limiter {
	return &Limiter{rc: rc, prefix: prefix, limit: limit, window: window}
}

// Allow 自增 key 计数，返回是否在窗内允许通过。
func (l *Limiter) Allow(ctx context.Context, key string) (bool, error) {
	full := l.prefix + key
	n, err := l.rc.Incr(ctx, full).Result()
	if err != nil {
		return false, err
	}
	if n == 1 {
		// 首次进入窗口，设过期
		_ = l.rc.Expire(ctx, full, l.window).Err()
	}
	return n <= l.limit, nil
}
