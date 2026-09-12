// Package task 的锁包装单测：验证同一周期内整个副本集只跑一次、
// 没抢到锁的副本安静返回 nil、TTL 过期后下一周期正常再跑一次。
package task

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/agentre-hub/agentre-server/internal/testutils"
)

// TestWithPeriodLock_SecondCallInSamePeriodSkips 是决定性用例：同一把锁在
// 同一周期内被调用两次，只有第一次真正执行 job，第二次安静跳过且不报错。
//
// 抢锁那条命令**本身**就是契约：副本之间只靠它协调，而它有三处一漂就出事、
// 又都不会有任何东西报错。三处在这里各有一条断言钉着，不需要严格 mock：
//
//   - key 掉出 task:cron 命名空间（撞上业务锁）→ 下面按字面量查 Exists
//   - 少了 NX（每个副本都抢得到，任务跑 N 遍）→ runs 会变成 2
//   - TTL 不是传进来的那个周期（大了就再也不跑，小了就重复跑）→ 下面查 TTL
func TestWithPeriodLock_SecondCallInSamePeriodSkips(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()

	var runs int32
	job := func(context.Context) error {
		atomic.AddInt32(&runs, 1)
		return nil
	}

	const key = "test:same_period"
	const ttl = time.Minute

	wrapped := withPeriodLock(key, ttl, job)

	assert.NoError(t, wrapped(ctx))
	err2 := wrapped(ctx)

	assert.NoError(t, err2, "没抢到锁的副本必须返回 nil，而不是错误")
	assert.Equal(t, int32(1), atomic.LoadInt32(&runs), "job 本体在整个周期内只应该真正跑一次；变成 2 说明抢锁少了 NX")

	// 键名写成字面量而不是 lockKeyPrefix+":"+key：那样两边同源，前缀改成什么
	// 期望就跟着变成什么，命名空间漂了也照样绿。这里要钉的正是那个字面量。
	assert.True(t, mini.Exists("task:cron:test:same_period"), "锁必须落在 task:cron 命名空间下的这个键上")
	assert.Equal(t, ttl, mini.TTL("task:cron:test:same_period"), "锁的 TTL 必须是传进来的那个周期")
}

// TestWithPeriodLock_NextPeriodRunsAgain 验证锁过期后下一周期能重新抢到锁并
// 再次执行。miniredis 的 TTL 走虚拟时钟、不随真实时间流逝，所以这里把时钟
// 直接推过锁的 TTL——这比删 key 更贴近生产：走的是 TTL 到期那条路径本身。
func TestWithPeriodLock_NextPeriodRunsAgain(t *testing.T) {
	mini := testutils.Redis(t)
	ctx := context.Background()

	var runs int32
	job := func(context.Context) error {
		atomic.AddInt32(&runs, 1)
		return nil
	}

	const key = "test:next_period"
	wrapped := withPeriodLock(key, time.Minute, job)

	assert.NoError(t, wrapped(ctx))
	mini.FastForward(time.Minute + time.Second)
	assert.NoError(t, wrapped(ctx))

	assert.Equal(t, int32(2), atomic.LoadInt32(&runs), "锁过期后，下一周期应当重新执行")
}
