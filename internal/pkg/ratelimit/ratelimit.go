// Package ratelimit 在 Redis 上实现简单的 INCR + PEXPIRE 计数限流。
//
// INCR 与首次过期合成一条 Lua 脚本，由 Redis 原子执行，
// 不会出现「计数已写、TTL 还没设上」的中间态（该脚本已用
// cago/pkg/utils/testutils.Redis() 起的 miniredis 实测跑通）。
// 允许一个时间窗内允许 N 次。
package ratelimit

import (
	"context"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// incrAndExpireScript 对 key 做 INCR；若这是该 key 在当前窗口的第一次自增
// （返回值为 1），顺带把它的存活时间设成 window（毫秒）。INCR 与
// PEXPIRE 在同一条脚本里执行，Redis 保证原子性。
var incrAndExpireScript = goredis.NewScript(`
local n = redis.call("INCR", KEYS[1])
if n == 1 then
	redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return n
`)

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
	n, err := incrAndExpireScript.Run(ctx, l.rc, []string{full}, l.window.Milliseconds()).Int64()
	if err != nil {
		return false, err
	}
	return n <= l.limit, nil
}
