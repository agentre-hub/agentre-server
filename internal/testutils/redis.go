package testutils

import (
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/cago-frame/cago/database/redis"
	cagotest "github.com/cago-frame/cago/pkg/utils/testutils"
	"github.com/go-redis/redismock/v9"
	goredis "github.com/redis/go-redis/v9"
)

// 这个文件有两个入口，选哪个由**被测对象是不是 Redis 交互本身**决定，不是风格偏好。
//
// 判据是一句话：先写出「这条断言失败时说明什么坏了」。
//
//   - 答案里点不到具体的命令、键名或参数（「登录态没建起来」「限流没拦住」），
//     那 Redis 只是环境依赖，被测的是别的东西 —— 用 Redis(t)。
//     等价的说法：把这次 Redis 交互整个换成另一种存储，断言仍然该成立。
//   - 答案就是某条命令发错了（「session 的 TTL 写成了秒」「锁没带 NX」），
//     那命令序列本身就是契约 —— 用 RedisMock(t)。
//
// 反过来用的代价是具体的：给「只要 Redis 能用」的用例写 redismock 期望，等于在用例里
// 抄一遍被测代码的命令序列，断言退化成同义反复，而且被测代码改一个键名就要跟着改一遍；
// 给「命令序列是契约」的用例上 miniredis，则命令发错了也照样绿。

// Redis 起一个**真的会存东西**的进程内 Redis，并把它装成全局 redis.Default()，
// 返回底层实例供 FastForward / 直接读写。
//
// 适用面见文件头的判据：Redis 只是环境依赖的那一类用例。命令不需要预先声明，
// 发什么都照常执行。
//
// 与 cago 的 testutils.Redis 有两处不同：一是那边现在是严格 redismock（见 RedisMock），
// 二是那边曾经的 miniredis 版本是进程级单例，同包用例共用一个实例、必须靠 FlushAll
// 互相让路；这里每个用例一个实例，t.Cleanup 里还原上一个全局实例。
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

// RedisMock 装上 cago 的严格命令 mock：期望按声明顺序匹配，未声明的命令直接报错，
// 用例结束时校验期望是否全部满足。
//
// 适用面见文件头的判据：命令序列本身就是被测契约的那一类用例。它挡得住 Redis(t)
// 挡不住的那种错 —— 键名写错、TTL 单位写错、少了 NX、多发了一条独立的 EXPIRE。
//
// 代价是期望必须写得出来：键来自 crypto/rand、payload 带毫秒时间戳这类用例，
// 期望只能靠通配去凑，凑出来的断言什么也没在验证，那种就该留在 Redis(t)。
func RedisMock(t *testing.T) redismock.ClientMock {
	t.Helper()
	return cagotest.Redis(t)
}
