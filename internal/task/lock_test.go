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
func TestWithPeriodLock_SecondCallInSamePeriodSkips(t *testing.T) {
	testutils.Redis(t)
	ctx := context.Background()

	var runs int32
	job := func(context.Context) error {
		atomic.AddInt32(&runs, 1)
		return nil
	}

	wrapped := withPeriodLock("test:same_period", time.Minute, job)

	assert.NoError(t, wrapped(ctx))
	err2 := wrapped(ctx)

	assert.NoError(t, err2, "没抢到锁的副本必须返回 nil，而不是错误")
	assert.Equal(t, int32(1), atomic.LoadInt32(&runs), "job 本体在整个周期内只应该真正跑一次")
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
