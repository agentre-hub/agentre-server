package testutils

import (
	"context"
	"testing"

	"github.com/cago-frame/cago/database/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Redis(t) 的契约是「装上去的东西真的会存」：不预先声明任何命令，
// 写进去再读出来必须拿到同一个值。这一条是它与 RedisMock 的分界线。
func TestRedis_StoresWhatWasWrittenWithoutDeclaringCommands(t *testing.T) {
	Redis(t)
	ctx := context.Background()

	require.NoError(t, redis.Default().Set(ctx, "k", "v", 0).Err())
	got, err := redis.Default().Get(ctx, "k").Result()

	require.NoError(t, err)
	assert.Equal(t, "v", got)
}

// 每个用例拿到的是自己的实例：上一个用例写下的键不会漏到下一个。
// 旧的 cago testutils.Redis() 是进程级单例，用例之间会互相看见对方的数据，
// mirror_svc 因此要在每次 setup 里 FlushAll。
func TestRedis_IsIsolatedPerTest(t *testing.T) {
	ctx := context.Background()

	t.Run("first", func(t *testing.T) {
		Redis(t)
		require.NoError(t, redis.Default().Set(ctx, "leak", "1", 0).Err())
	})

	t.Run("second", func(t *testing.T) {
		Redis(t)
		n, err := redis.Default().Exists(ctx, "leak").Result()
		require.NoError(t, err)
		assert.Zero(t, n, "上一个用例的键不该出现在这里")
	})
}

// 用例结束后全局实例要还原，否则同包里没装 Redis 的用例会连到一个已经关掉的实例。
func TestRedis_RestoresThePreviousDefault(t *testing.T) {
	before := redis.Default()

	t.Run("inner", func(t *testing.T) { Redis(t) })

	assert.Same(t, before, redis.Default(), "Cleanup 必须把全局实例放回去")
}

// RedisMock(t) 的契约恰好相反：没声明过的命令必须报错，而不是照常执行。
// 这是「命令序列本身就是被测契约」那一类用例赖以成立的前提。
func TestRedisMock_RejectsAnUndeclaredCommand(t *testing.T) {
	mock := RedisMock(t)
	ctx := context.Background()
	mock.ExpectSet("declared", "v", 0).SetVal("OK")

	require.NoError(t, redis.Default().Set(ctx, "declared", "v", 0).Err())
	err := redis.Default().Get(ctx, "undeclared").Err()

	assert.Error(t, err, "未声明的命令必须失败，否则这层 mock 什么也没在把关")
}
