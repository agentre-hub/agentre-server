package testutils

import (
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/database/redis"
	goredis "github.com/redis/go-redis/v9"
)

// Redis 起一个**真的会存东西**的进程内 Redis，并把它装成全局 redis.Default()，
// 返回底层实例供 FastForward / 直接读写。
//
// 这是本仓库测试里取 Redis 的唯一方式。不用命令级 mock：这里的 Redis 用例大多
// 是行为测试，而让它们成立的正是 miniredis 真的在执行 Lua、TTL 与 SETNX——
// 换成罐头返回值，断言就退化成把被测代码的命令序列再抄一遍。
//
// 命令序列本身是契约的那种用例（键名、TTL 单位、少了 NX），照样在这里钉得住：
// 跑完之后按字面量查 mini.Exists / mini.TTL 即可，见 internal/task/lock_test.go。
// 这比声明命令期望更耐改——它断言的是最终状态，不是达成状态的路径。
//
// 与 cago 的 testutils.Redis 有两处不同：一是那边现在返回严格的命令 mock，
// 二是那边曾经的 miniredis 版本是进程级单例，同包用例共用一个实例、必须靠
// FlushAll 互相让路；这里每个用例一个实例，t.Cleanup 里还原上一个全局实例。
func Redis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	mini := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: mini.Addr()})
	prev := redis.Default()
	redis.SetDefault(client)
	t.Cleanup(func() {
		redis.SetDefault(prev)
		_ = client.Close()
	})
	return mini
}
